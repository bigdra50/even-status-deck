// client source: companion WebView の geolocation で現在地を取り、open-meteo(キー不要)から
// 現在の気象を取得して StatusDoc(weather group)を返す。glass/companion は store 経由で購読する。
//
// 設計(codex と確定): 位置は WebView 側にしか無い(SDK に GPS 無し)。座標は丸めてプライバシーを抑え、
// localStorage に TTL キャッシュして open-meteo を高頻度に叩かない。store の poll(60s)から呼ばれるが、
// fresh(30分)の間は geolocation も network も呼ばず cache を返す。失敗時は stale(6時間)→error と degrade。
// glass の tofu を避けるため値は ASCII のみ(絵文字を使わない)。
import {
  type Group,
  parseStatusDoc,
  type Segment,
  type SourceState,
  type StatusDoc,
} from './status-types'

export const WEATHER_GROUP_ID = 'weather'

const CACHE_KEY = 'toolbar.weather.cache'
const FRESH_MS = 30 * 60_000 // この間は再取得しない(cache をそのまま返す)
const STALE_MAX_MS = 6 * 60 * 60_000 // 失敗時に cache を stale 表示してよい上限
const GEO_TIMEOUT_MS = 10_000
const GEO_MAX_AGE_MS = 30 * 60_000 // OS の位置キャッシュ許容(初回以外は許可ダイアログを出さない)

type Cache = { lat: number; lon: number; fetchedAt: number; doc: StatusDoc }

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// WMO weather_code → 短い ASCII ラベル(glass 9 桁枠に収まる範囲)。
export function weatherCodeText(code: number): string {
  if (code === 0 || code === 1) return 'Clear'
  if (code === 2) return 'Cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67) return 'Rain'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Snow'
  if (code >= 80 && code <= 82) return 'Showers'
  if (code >= 95 && code <= 99) return 'Storm'
  return 'Wx' // 未知/欠落コード
}

// 気象値から weather group の StatusDoc を組む。temp/cond は既定 ON、wind は既定 OFF。
export function buildWeatherDoc(
  tempC: number,
  code: number,
  windKmh: number,
  ts: number,
  state?: SourceState,
  message?: string,
): StatusDoc {
  const segments: Segment[] = [
    {
      id: 'temp',
      label: '',
      value: `${Math.round(tempC)}C`, // ASCII のみ (° は実機フォントで tofu になり得るため使わない)
      defaultEnabled: true,
      widthChars: 4,
      isNumeric: true,
    },
    { id: 'cond', label: '', value: weatherCodeText(code), defaultEnabled: true, widthChars: 9 },
    {
      id: 'wind',
      label: 'Wind',
      value: `${Math.round(windKmh)}km/h`,
      defaultEnabled: false,
      widthChars: 8,
    },
  ]
  const group: Group = { id: WEATHER_GROUP_ID, label: 'Weather', segments }
  if (state) group.state = state
  if (message) group.message = message
  return { version: 1, ts, groups: [group] }
}

// 取得不能時の最小 StatusDoc(source を消さず n/a + error 状態で残す)。
function errorDoc(message: string, ts: number): StatusDoc {
  const group: Group = {
    id: WEATHER_GROUP_ID,
    label: 'Weather',
    state: 'error',
    message,
    segments: [{ id: 'temp', label: '', value: 'n/a', defaultEnabled: true, widthChars: 4 }],
  }
  return { version: 1, ts, groups: [group] }
}

// cache 済み doc を別 state(stale 等)で複製する。
function withState(doc: StatusDoc, state: SourceState, message: string): StatusDoc {
  return {
    version: doc.version,
    ts: doc.ts,
    groups: doc.groups.map((g) => ({
      ...g,
      state,
      message,
      segments: g.segments.map((s) => ({ ...s })),
    })),
  }
}

function readCache(): Cache | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<Cache>
    if (typeof c.lat !== 'number' || typeof c.lon !== 'number' || typeof c.fetchedAt !== 'number') {
      return null
    }
    // localStorage は古いバージョン/改竄で壊れ得る境界。doc を StatusDoc 形に検証してから採用する
    // (壊れた cache を store へ注入して描画前提を壊さない)。
    const doc = parseStatusDoc(c.doc)
    if (!doc) return null
    return { lat: c.lat, lon: c.lon, fetchedAt: c.fetchedAt, doc }
  } catch {
    return null
  }
}

function writeCache(c: Cache): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(c))
  } catch {
    // quota 等は無視(キャッシュは best-effort)
  }
}

// 現在地を 1 回取得する(コールバック API を Promise 化)。初回のみ OS 許可ダイアログが出る。
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

type OpenMeteoCurrent = { tempC: number; code: number; windKmh: number }

// open-meteo の現在天気 URL。外部 fetch 先を限定するため host は api.open-meteo.com 固定。
export function openMeteoUrl(lat: number, lon: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,weather_code,wind_speed_10m' +
    '&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto'
  )
}

async function fetchOpenMeteo(
  lat: number,
  lon: number,
  signal: AbortSignal,
): Promise<OpenMeteoCurrent> {
  const res = await fetch(openMeteoUrl(lat, lon), { signal })
  if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`)
  const json = (await res.json()) as { current?: Record<string, unknown> }
  const cur = json.current
  if (!cur || typeof cur.temperature_2m !== 'number') throw new Error('open-meteo: no current data')
  return {
    tempC: cur.temperature_2m,
    code: typeof cur.weather_code === 'number' ? cur.weather_code : -1,
    windKmh: typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : 0,
  }
}

// client source の producer。store.refreshSource(kind==='client') から poll ごとに呼ばれる。
// fresh cache があれば即返し、無ければ geolocation→open-meteo を取得。失敗は stale/error に degrade。
export async function weatherStatus(signal: AbortSignal): Promise<StatusDoc | null> {
  const now = Date.now()
  const cache = readCache()
  if (cache && now - cache.fetchedAt < FRESH_MS) return cache.doc // 新鮮: 何もしない
  try {
    const pos = await getPosition()
    if (signal.aborted) return null
    const lat = round2(pos.lat)
    const lon = round2(pos.lon)
    const w = await fetchOpenMeteo(lat, lon, signal)
    if (signal.aborted) return null
    const doc = buildWeatherDoc(w.tempC, w.code, w.windKmh, Date.now())
    writeCache({ lat, lon, fetchedAt: Date.now(), doc })
    return doc
  } catch (err) {
    if (signal.aborted) return null
    // 失敗: cache が stale 範囲内なら最後の値を stale 表示、無ければ error doc(source は残す)。
    if (cache && now - cache.fetchedAt < STALE_MAX_MS) {
      return withState(cache.doc, 'stale', 'using cached weather')
    }
    return errorDoc(err instanceof Error ? err.message : 'weather unavailable', now)
  }
}
