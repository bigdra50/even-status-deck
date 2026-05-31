// client source: 現在地の標高(open-meteo /v1/elevation)とタイムゾーン(/v1/forecast?timezone=auto)を
// 取得して geoinfo group を返す(#45)。weather と同じ geolocation/round2(PII)/TTL/stale-error degrade パターン。
// 値は ASCII のみ(°/絵文字は実機 tofu)。ホストは api.open-meteo.com で weather と同一(whitelist 追加不要)。
//
// 設計: 標高/TZ は変化が遅いので 6h fresh。表示単位(elevUnit)は client 側の純変換(URL に影響しない)なので、
// cache には「生の reading」を保存し、毎回 opts で doc を rebuild する(単位変更は再 fetch 不要で即反映)。
// 現地の live clock(now segment)は毎分 glassTick 再計算が要るため別途(#38 と同機構)。本 source は静的値のみ。
import type { OptionValues } from './config'
import type { Group, Segment, SourceState, StatusDoc } from './status-types'

export const GEOINFO_GROUP_ID = 'geoinfo'

const CACHE_KEY = 'toolbar.geoinfo.cache'
const FRESH_MS = 6 * 60 * 60_000 // 標高/TZ は変化が遅い。6h は再取得しない。
const STALE_MAX_MS = 24 * 60 * 60_000 // 失敗時に cache を stale 表示してよい上限。
const GEO_TIMEOUT_MS = 10_000
const GEO_MAX_AGE_MS = 30 * 60_000
const FETCH_TIMEOUT_MS = 8_000

// source 単位の表示オプション(#36 基盤の SourceDef.options)。標高の単位のみ。
export type GeoinfoOptions = { elevUnit: 'm' | 'ft' }
export const DEFAULT_GEOINFO_OPTIONS: GeoinfoOptions = { elevUnit: 'm' }

export function readGeoinfoOptions(bag: OptionValues | undefined): GeoinfoOptions {
  return { elevUnit: bag?.elevUnit === 'ft' ? 'ft' : 'm' }
}

// メートル → フィート。
export function metersToFeet(m: number): number {
  return m * 3.280839895
}

// IANA timezone "Asia/Tokyo" → 末尾の地名 "Tokyo"(ASCII、アンダースコアは空白に)。
export function tzCity(timezone: string): string {
  const last = timezone.split('/').pop() ?? timezone
  return last.replace(/_/g, ' ')
}

// utc_offset_seconds → "UTC+9" / "UTC-3:30"(ASCII、分は 0 でなければ付ける)。
export function tzOffsetLabel(offsetSec: number): string {
  const sign = offsetSec < 0 ? '-' : '+'
  const abs = Math.abs(offsetSec)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`
}

// producer が組み立てた素の読み取り(欠落し得る optional)。欠落フィールドの segment は push しない。
export type GeoinfoReading = {
  elevationM?: number
  utcOffsetSec?: number
  timezone?: string
}

// reading + 単位から geoinfo group の StatusDoc を組む。全 segment は既定 OFF(opt-in)。
export function buildGeoinfoDoc(
  r: GeoinfoReading,
  opts: GeoinfoOptions,
  ts: number,
  state?: SourceState,
  message?: string,
): StatusDoc {
  const segments: Segment[] = []
  if (typeof r.elevationM === 'number') {
    const value =
      opts.elevUnit === 'ft'
        ? `${Math.round(metersToFeet(r.elevationM))}ft`
        : `${Math.round(r.elevationM)}m`
    segments.push({
      id: 'elev',
      label: 'Alt',
      value,
      defaultEnabled: false,
      widthChars: 7,
      isNumeric: true,
    })
  }
  if (typeof r.utcOffsetSec === 'number') {
    segments.push({
      id: 'tz',
      label: '',
      value: tzOffsetLabel(r.utcOffsetSec),
      defaultEnabled: false,
      widthChars: 8,
    })
  }
  if (r.timezone) {
    segments.push({
      id: 'zone',
      label: '',
      value: tzCity(r.timezone),
      defaultEnabled: false,
      widthChars: 12,
    })
  }
  const group: Group = { id: GEOINFO_GROUP_ID, label: 'Location', segments }
  if (state) group.state = state
  if (message) group.message = message
  return { version: 1, ts, groups: [group] }
}

function errorDoc(message: string, ts: number): StatusDoc {
  const group: Group = {
    id: GEOINFO_GROUP_ID,
    label: 'Location',
    state: 'error',
    message,
    segments: [{ id: 'elev', label: 'Alt', value: 'n/a', defaultEnabled: false, widthChars: 7 }],
  }
  return { version: 1, ts, groups: [group] }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

type Cache = { lat: number; lon: number; fetchedAt: number; reading: GeoinfoReading }

function readCache(): Cache | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<Cache>
    if (typeof c.lat !== 'number' || typeof c.lon !== 'number' || typeof c.fetchedAt !== 'number') {
      return null
    }
    const rd = c.reading
    if (!rd || typeof rd !== 'object') return null
    const reading: GeoinfoReading = {}
    if (typeof rd.elevationM === 'number') reading.elevationM = rd.elevationM
    if (typeof rd.utcOffsetSec === 'number') reading.utcOffsetSec = rd.utcOffsetSec
    if (typeof rd.timezone === 'string') reading.timezone = rd.timezone
    return { lat: c.lat, lon: c.lon, fetchedAt: c.fetchedAt, reading }
  } catch {
    return null
  }
}

function writeCache(c: Cache): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(c))
  } catch {
    // quota 等は無視(best-effort)
  }
}

function getPosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('geolocation unavailable'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(`geolocation error ${e.code}: ${e.message}`)),
      { enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: GEO_MAX_AGE_MS },
    )
  })
}

export function elevationUrl(lat: number, lon: number): string {
  return `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`
}

export function tzUrl(lat: number, lon: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m&timezone=auto'
  )
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// timeout + 外部 signal を合流させて fetch する(ハングで source が永遠に灰色になるのを防ぐ)。
async function fetchJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

// 標高(/v1/elevation)+ TZ(/v1/forecast) を並列取得して reading にまとめる。
// 片方が落ちても取れた分は返す(allSettled)。両方落ちたら throw。
async function fetchGeoinfo(
  lat: number,
  lon: number,
  signal: AbortSignal,
): Promise<GeoinfoReading> {
  const [elevRes, tzRes] = await Promise.allSettled([
    fetchJson(elevationUrl(lat, lon), signal),
    fetchJson(tzUrl(lat, lon), signal),
  ])
  const reading: GeoinfoReading = {}
  if (elevRes.status === 'fulfilled') {
    const arr = elevRes.value.elevation
    if (Array.isArray(arr)) reading.elevationM = num(arr[0])
  }
  if (tzRes.status === 'fulfilled') {
    reading.utcOffsetSec = num(tzRes.value.utc_offset_seconds)
    if (typeof tzRes.value.timezone === 'string') reading.timezone = tzRes.value.timezone
  }
  if (
    reading.elevationM === undefined &&
    reading.utcOffsetSec === undefined &&
    reading.timezone === undefined
  ) {
    throw new Error('geoinfo: no data')
  }
  return reading
}

const FAIL_BACKOFF_MS = 5 * 60_000
let lastFailAt = 0
let lastFailMsg = 'location info unavailable'

function degraded(cache: Cache | null, opts: GeoinfoOptions, now: number, msg: string): StatusDoc {
  if (cache && now - cache.fetchedAt < STALE_MAX_MS) {
    return buildGeoinfoDoc(cache.reading, opts, now, 'stale', 'using cached location info')
  }
  return errorDoc(msg, now)
}

// client source の producer。store.refreshSource(kind==='client') から呼ばれる。
// fresh cache があれば再 fetch せず、生 reading を現 opts で rebuild して返す(単位変更が即反映)。
export async function geoinfoStatus(
  signal: AbortSignal,
  options?: OptionValues,
): Promise<StatusDoc | null> {
  const opts = readGeoinfoOptions(options)
  const now = Date.now()
  const cache = readCache()
  if (cache && now - cache.fetchedAt < FRESH_MS) {
    return buildGeoinfoDoc(cache.reading, opts, cache.fetchedAt) // 単位は opts で都度 rebuild
  }
  if (now - lastFailAt < FAIL_BACKOFF_MS) return degraded(cache, opts, now, lastFailMsg)
  console.log('[geoinfo] requesting location…')
  try {
    const pos = await getPosition()
    if (signal.aborted) return null
    const lat = round2(pos.lat)
    const lon = round2(pos.lon)
    const reading = await fetchGeoinfo(lat, lon, signal)
    if (signal.aborted) return null
    lastFailAt = 0
    console.log(`[geoinfo] ok elev=${reading.elevationM ?? 'n/a'} tz=${reading.timezone ?? 'n/a'}`)
    const at = Date.now()
    writeCache({ lat, lon, fetchedAt: at, reading })
    return buildGeoinfoDoc(reading, opts, at)
  } catch (err) {
    if (signal.aborted) return null
    lastFailMsg = err instanceof Error ? err.message : 'location info unavailable'
    lastFailAt = now
    console.warn(`[geoinfo] failed: ${lastFailMsg}`)
    return degraded(cache, opts, now, lastFailMsg)
  }
}
