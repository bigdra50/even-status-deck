// client source: 現在地の空気質(AQI/PM2.5/PM10)+ 花粉を取得して airquality group を返す(#41)。
// weather と同じ geolocation/round2(PII)/TTL/stale-error degrade パターン。値は ASCII のみ(µg/m³ や絵文字は
// 実機 tofu になるため使わない=ラベルで単位を含意し値は数値のみ)。
//
// ホストは air-quality-api.open-meteo.com で weather(api.open-meteo.com)とは別。app.json の network whitelist に
// 追加が要る(本 PR で追加)。AQI 規格(us/eu)は表示の選択(同一レスポンスに両方含まれる)なので、cache には生の
// reading を保存し毎回 opts で doc を rebuild する(規格切替は再 fetch 不要で即反映 = geoinfo と同方式)。
import type { OptionValues } from './config'
import { getRoundedPosition } from './geo-position'
import type { Group, Segment, SourceState, StatusDoc } from './status-types'
import {
  type GeoCacheEntry,
  isCacheFresh,
  isCacheStaleOk,
  readGeoCache,
  writeGeoCache,
} from './ttl-cache'

export const AIRQUALITY_GROUP_ID = 'airquality'

const HOST = 'https://air-quality-api.open-meteo.com'
const CACHE_KEY = 'toolbar.airquality.cache'
const FRESH_MS = 30 * 60_000 // AQI は時間粒度。30分は再取得しない。
const STALE_MAX_MS = 6 * 60 * 60_000
const FETCH_TIMEOUT_MS = 8_000

// source 単位の表示オプション。AQI 規格(US/EU)のみ。両値は同一レスポンスに含まれるので表示の選択。
export type AirqualityOptions = { aqiStandard: 'us' | 'eu' }
export const DEFAULT_AIRQUALITY_OPTIONS: AirqualityOptions = { aqiStandard: 'us' }

export function readAirqualityOptions(bag: OptionValues | undefined): AirqualityOptions {
  return { aqiStandard: bag?.aqiStandard === 'eu' ? 'eu' : 'us' }
}

// 花粉の最大濃度(grains/m³)→ ASCII レベル。open-meteo 花粉は欧州中心で、非対応地域は undefined(segment を出さない)。
// しきい値は概算(実機/地域で要調整)。0 は監視ありで飛散なし = None。
export function pollenLevel(grains: number): string {
  if (grains < 1) return 'None'
  if (grains < 15) return 'Low'
  if (grains < 50) return 'Med'
  return 'High'
}

// producer が組み立てた素の読み取り(欠落し得る optional)。欠落フィールドの segment は push しない。
export type AirqualityReading = {
  usAqi?: number
  euAqi?: number
  pm25?: number
  pm10?: number
  pollenMax?: number // 花粉 6 種(alder/birch/grass/mugwort/olive/ragweed)の最大。非対応地域は undefined。
}

// reading + 規格から airquality group の StatusDoc を組む。aqi は既定 ON(source の headline)、他は既定 OFF。
export function buildAirqualityDoc(
  r: AirqualityReading,
  opts: AirqualityOptions,
  ts: number,
  state?: SourceState,
  message?: string,
): StatusDoc {
  const segments: Segment[] = []
  const aqi = opts.aqiStandard === 'eu' ? r.euAqi : r.usAqi
  if (typeof aqi === 'number') {
    segments.push({
      id: 'aqi',
      label: 'AQI',
      value: `${Math.round(aqi)}`,
      defaultEnabled: true,
      widthChars: 7,
      isNumeric: true,
    })
  }
  if (typeof r.pm25 === 'number') {
    segments.push({
      id: 'pm25',
      label: 'PM2.5',
      value: `${Math.round(r.pm25)}`,
      defaultEnabled: false,
      widthChars: 9,
      isNumeric: true,
    })
  }
  if (typeof r.pm10 === 'number') {
    segments.push({
      id: 'pm10',
      label: 'PM10',
      value: `${Math.round(r.pm10)}`,
      defaultEnabled: false,
      widthChars: 8,
      isNumeric: true,
    })
  }
  if (typeof r.pollenMax === 'number') {
    segments.push({
      id: 'pollen',
      label: 'Pollen',
      value: pollenLevel(r.pollenMax),
      defaultEnabled: false,
      widthChars: 11,
    })
  }
  const group: Group = { id: AIRQUALITY_GROUP_ID, label: 'Air', segments }
  if (state) group.state = state
  if (message) group.message = message
  return { version: 1, ts, groups: [group] }
}

function errorDoc(message: string, ts: number): StatusDoc {
  const group: Group = {
    id: AIRQUALITY_GROUP_ID,
    label: 'Air',
    state: 'error',
    message,
    segments: [{ id: 'aqi', label: 'AQI', value: 'n/a', defaultEnabled: true, widthChars: 7 }],
  }
  return { version: 1, ts, groups: [group] }
}

// cache の payload(reading)型ガード。壊れた JSON / 型不一致のフィールドは落とす。
function parseAirqualityReading(raw: unknown): AirqualityReading | null {
  if (!raw || typeof raw !== 'object') return null
  const rd = raw as Record<string, unknown>
  const reading: AirqualityReading = {}
  for (const k of ['usAqi', 'euAqi', 'pm25', 'pm10', 'pollenMax'] as const) {
    if (typeof rd[k] === 'number') reading[k] = rd[k]
  }
  return reading
}

type Cache = GeoCacheEntry<AirqualityReading>

export function airqualityUrl(lat: number, lon: number): string {
  return (
    `${HOST}/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    '&current=us_aqi,european_aqi,pm2_5,pm10,' +
    'alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen' +
    '&timezone=auto'
  )
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// current の花粉 6 種から最大濃度を取る。すべて null/欠落(非対応地域)なら undefined。
function maxPollen(cur: Record<string, unknown>): number | undefined {
  const species = [
    'alder_pollen',
    'birch_pollen',
    'grass_pollen',
    'mugwort_pollen',
    'olive_pollen',
    'ragweed_pollen',
  ]
  let max: number | undefined
  for (const s of species) {
    const v = num(cur[s])
    if (v !== undefined) max = max === undefined ? v : Math.max(max, v)
  }
  return max
}

async function fetchAirquality(
  lat: number,
  lon: number,
  signal: AbortSignal,
): Promise<AirqualityReading> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(airqualityUrl(lat, lon), { signal: ctl.signal })
    if (!res.ok) throw new Error(`air-quality HTTP ${res.status}`)
    const json = (await res.json()) as { current?: Record<string, unknown> }
    const cur = json.current
    if (!cur) throw new Error('air-quality: no current data')
    const reading: AirqualityReading = {
      usAqi: num(cur.us_aqi),
      euAqi: num(cur.european_aqi),
      pm25: num(cur.pm2_5),
      pm10: num(cur.pm10),
      pollenMax: maxPollen(cur),
    }
    if (
      reading.usAqi === undefined &&
      reading.euAqi === undefined &&
      reading.pm25 === undefined &&
      reading.pm10 === undefined
    ) {
      throw new Error('air-quality: empty')
    }
    return reading
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

const FAIL_BACKOFF_MS = 5 * 60_000
let lastFailAt = 0
let lastFailMsg = 'air quality unavailable'

function degraded(
  cache: Cache | null,
  opts: AirqualityOptions,
  now: number,
  msg: string,
): StatusDoc {
  if (isCacheStaleOk(cache, now, STALE_MAX_MS)) {
    return buildAirqualityDoc(cache.payload, opts, now, 'stale', 'using cached air quality')
  }
  return errorDoc(msg, now)
}

// client source の producer。fresh cache があれば再 fetch せず、生 reading を現 opts で rebuild して返す
// (AQI 規格切替が再 fetch 無しに即反映)。
export async function airqualityStatus(
  signal: AbortSignal,
  options?: OptionValues,
): Promise<StatusDoc | null> {
  const opts = readAirqualityOptions(options)
  const now = Date.now()
  const cache = readGeoCache(CACHE_KEY, parseAirqualityReading)
  if (isCacheFresh(cache, now, FRESH_MS)) {
    return buildAirqualityDoc(cache.payload, opts, cache.fetchedAt)
  }
  if (now - lastFailAt < FAIL_BACKOFF_MS) return degraded(cache, opts, now, lastFailMsg)
  console.log('[airquality] requesting location…')
  try {
    const { lat, lon } = await getRoundedPosition()
    if (signal.aborted) return null
    const reading = await fetchAirquality(lat, lon, signal)
    if (signal.aborted) return null
    lastFailAt = 0
    console.log(`[airquality] ok us=${reading.usAqi ?? 'n/a'} eu=${reading.euAqi ?? 'n/a'}`)
    const at = Date.now()
    writeGeoCache(CACHE_KEY, { lat, lon, fetchedAt: at, payload: reading })
    return buildAirqualityDoc(reading, opts, at)
  } catch (err) {
    if (signal.aborted) return null
    lastFailMsg = err instanceof Error ? err.message : 'air quality unavailable'
    lastFailAt = now
    console.warn(`[airquality] failed: ${lastFailMsg}`)
    return degraded(cache, opts, now, lastFailMsg)
  }
}
