// client source: 現在地の座標から地名を逆ジオコーディングして place group を返す(#37)。
// weather と同じ geolocation/round2(PII)/TTL/stale-error degrade パターン。値は ASCII のみ。
//
// ホストは api.bigdatacloud.net(reverse-geocode-client, キー不要)で weather と別。app.json の network
// whitelist に追加が要る(本 PR で追加)。地名は localityLanguage=en で英語化して取得し、さらに asciiFold で
// アクセント(São→Sao 等)を除去して実機 tofu を避ける。表示オプションは無し(英語固定)。
import type { OptionValues } from './config'
import type { Group, Segment, SourceState, StatusDoc } from './status-types'

export const GEOCODE_GROUP_ID = 'geocode'

const HOST = 'https://api.bigdatacloud.net'
const CACHE_KEY = 'toolbar.geocode.cache'
const FRESH_MS = 30 * 60_000 // 移動しても市レベルは変化が遅い。30分は再取得しない。
const STALE_MAX_MS = 6 * 60 * 60_000
const GEO_TIMEOUT_MS = 10_000
const GEO_MAX_AGE_MS = 30 * 60_000
const FETCH_TIMEOUT_MS = 8_000

// 文字列を ASCII へ畳む。NFD 分解 → 結合文字(アクセント)除去 → 非 ASCII を空白化。実機フォントの
// tofu(°/アクセント/CJK)を避ける。en 取得済みなので大半はそのまま、残った非 ASCII だけ落とす。
export function asciiFold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // 結合ダイアクリティカルマーク(アクセント)
    .replace(/[^ -~]/g, ' ') // 残った非 ASCII(CJK 等)を空白化
    .replace(/\s+/g, ' ')
    .trim()
}

// producer が組み立てた素の読み取り(欠落し得る optional)。欠落フィールドの segment は push しない。
export type GeocodeReading = {
  city?: string
  area?: string // locality/neighborhood (city と異なるときのみ)
  region?: string // principalSubdivision (都道府県/州)
  country?: string
}

// reading から place group の StatusDoc を組む。city は既定 ON(headline)、他は既定 OFF。値は asciiFold 済み。
export function buildGeocodeDoc(
  r: GeocodeReading,
  _opts: OptionValues | undefined,
  ts: number,
  state?: SourceState,
  message?: string,
): StatusDoc {
  const segments: Segment[] = []
  if (r.city) {
    segments.push({
      id: 'city',
      label: '',
      value: asciiFold(r.city),
      defaultEnabled: true,
      widthChars: 12,
    })
  }
  if (r.area) {
    segments.push({
      id: 'area',
      label: '',
      value: asciiFold(r.area),
      defaultEnabled: false,
      widthChars: 14,
    })
  }
  if (r.region) {
    segments.push({
      id: 'region',
      label: '',
      value: asciiFold(r.region),
      defaultEnabled: false,
      widthChars: 14,
    })
  }
  if (r.country) {
    segments.push({
      id: 'country',
      label: '',
      value: asciiFold(r.country),
      defaultEnabled: false,
      widthChars: 12,
    })
  }
  const group: Group = { id: GEOCODE_GROUP_ID, label: 'Place', segments }
  if (state) group.state = state
  if (message) group.message = message
  return { version: 1, ts, groups: [group] }
}

function errorDoc(message: string, ts: number): StatusDoc {
  const group: Group = {
    id: GEOCODE_GROUP_ID,
    label: 'Place',
    state: 'error',
    message,
    segments: [{ id: 'city', label: '', value: 'n/a', defaultEnabled: true, widthChars: 12 }],
  }
  return { version: 1, ts, groups: [group] }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

type Cache = { lat: number; lon: number; fetchedAt: number; reading: GeocodeReading }

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
    const reading: GeocodeReading = {}
    for (const k of ['city', 'area', 'region', 'country'] as const) {
      if (typeof rd[k] === 'string') reading[k] = rd[k]
    }
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

export function geocodeUrl(lat: number, lon: number): string {
  return `${HOST}/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

async function fetchGeocode(
  lat: number,
  lon: number,
  signal: AbortSignal,
): Promise<GeocodeReading> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(geocodeUrl(lat, lon), { signal: ctl.signal })
    if (!res.ok) throw new Error(`bigdatacloud HTTP ${res.status}`)
    const json = (await res.json()) as Record<string, unknown>
    const city = str(json.city)
    const locality = str(json.locality)
    const reading: GeocodeReading = {
      city: city ?? locality,
      // locality が city と別名(より詳細な地区)のときだけ area として出す
      area: locality && locality !== city ? locality : undefined,
      region: str(json.principalSubdivision),
      country: str(json.countryName),
    }
    if (!reading.city && !reading.region && !reading.country) {
      throw new Error('bigdatacloud: no place')
    }
    return reading
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

const FAIL_BACKOFF_MS = 5 * 60_000
let lastFailAt = 0
let lastFailMsg = 'place unavailable'

function degraded(cache: Cache | null, now: number, msg: string): StatusDoc {
  if (cache && now - cache.fetchedAt < STALE_MAX_MS) {
    return buildGeocodeDoc(cache.reading, undefined, now, 'stale', 'using cached place')
  }
  return errorDoc(msg, now)
}

// client source の producer。fresh cache があれば再 fetch せず保持値を返す。
export async function geocodeStatus(
  signal: AbortSignal,
  _options?: OptionValues,
): Promise<StatusDoc | null> {
  const now = Date.now()
  const cache = readCache()
  if (cache && now - cache.fetchedAt < FRESH_MS)
    return buildGeocodeDoc(cache.reading, undefined, cache.fetchedAt)
  if (now - lastFailAt < FAIL_BACKOFF_MS) return degraded(cache, now, lastFailMsg)
  console.log('[geocode] requesting location…')
  try {
    const pos = await getPosition()
    if (signal.aborted) return null
    const lat = round2(pos.lat)
    const lon = round2(pos.lon)
    const reading = await fetchGeocode(lat, lon, signal)
    if (signal.aborted) return null
    lastFailAt = 0
    console.log(`[geocode] ok ${reading.city ?? 'n/a'}`)
    const at = Date.now()
    writeCache({ lat, lon, fetchedAt: at, reading })
    return buildGeocodeDoc(reading, undefined, at)
  } catch (err) {
    if (signal.aborted) return null
    lastFailMsg = err instanceof Error ? err.message : 'place unavailable'
    lastFailAt = now
    console.warn(`[geocode] failed: ${lastFailMsg}`)
    return degraded(cache, now, lastFailMsg)
  }
}
