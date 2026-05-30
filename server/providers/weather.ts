// 気象 provider (open-meteo)。keyless・無料の open-meteo forecast API を server で叩き、
// 気温/天気/最高最低/降水確率/風を segment 化する (roadmap B-1 / PROTOCOL §9 builtin)。
//
// 座標は config の [providers.weather] に手入力する (自動 geolocation は iOS WebView 権限が
// 不確実なため避ける)。座標未設定なら null を返し、group を一切出さない (= 設定で初めて有効化)。
// 天気アイコンは絵文字 (☀ 等は U+2600 帯で glyphs.sanitize に除去される) を避け、短い英語表記で出す。
import type { Group, ProviderCtx, Segment } from '../types.ts'

// open-meteo forecast endpoint。current + daily(1 日) だけを取る軽量リクエスト。
const ENDPOINT = 'https://api.open-meteo.com/v1/forecast'
const FETCH_TIMEOUT_MS = 4000

// WMO weather code → 短い英語表記 (glass で読める ASCII。絵文字は使わない)。
// https://open-meteo.com/en/docs の Weather variable documentation 準拠。
function describeWeather(code: number): string {
  if (code === 0) return 'Clear'
  if (code === 1) return 'Mostly clear'
  if (code === 2) return 'Partly cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 82) return 'Showers'
  if (code === 85 || code === 86) return 'Snow showers'
  if (code >= 95) return 'Storm'
  return 'n/a'
}

// option を数値として読む (TOML は number、JSON も number だが文字列も許容して堅くする)。
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

type OpenMeteoResp = {
  current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number }
  daily?: {
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_probability_max?: number[]
  }
}

// 設定: latitude / longitude (必須)、label (表示名)、units ('metric'|'imperial')。
export async function weatherProvider(ctx: ProviderCtx): Promise<Group | null> {
  const opts = ctx.options
  const lat = num(opts.latitude ?? opts.lat)
  const lon = num(opts.longitude ?? opts.lon ?? opts.lng)
  // 座標未設定 (or 不正) は「未設定」とみなし group を出さない。
  if (lat === undefined || lon === undefined) return null

  const label = str(opts.label) ?? str(opts.name) ?? 'Weather'
  const imperial = str(opts.units) === 'imperial'
  const tempUnit = imperial ? 'fahrenheit' : 'celsius'
  const windUnit = imperial ? 'mph' : 'ms'
  const windLabel = imperial ? 'mph' : 'm/s'

  const url = new URL(ENDPOINT)
  url.searchParams.set('latitude', String(lat))
  url.searchParams.set('longitude', String(lon))
  url.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m')
  url.searchParams.set(
    'daily',
    'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  )
  url.searchParams.set('temperature_unit', tempUnit)
  url.searchParams.set('wind_speed_unit', windUnit)
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('forecast_days', '1')

  const errorGroup: Group = {
    id: 'weather',
    label,
    segments: [{ id: 'temp', label, value: 'n/a', defaultEnabled: true }],
    state: 'error',
    message: 'weather unavailable',
  }

  let data: OpenMeteoResp
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return errorGroup
    data = (await res.json()) as OpenMeteoResp
  } catch {
    return errorGroup
  }

  const cur = data.current
  if (!cur || typeof cur.temperature_2m !== 'number') return errorGroup

  const temp = Math.round(cur.temperature_2m)
  const segments: Segment[] = []

  // 現在気温 + 天気 (例: "21° Clear")。label は地名。常時 ON。
  const cond = typeof cur.weather_code === 'number' ? describeWeather(cur.weather_code) : ''
  segments.push({
    id: 'temp',
    label,
    value: cond ? `${temp}° ${cond}` : `${temp}°`,
    defaultEnabled: true,
  })

  // 最高/最低 (例: "21°/14°")。既定 OFF。
  const max = data.daily?.temperature_2m_max?.[0]
  const min = data.daily?.temperature_2m_min?.[0]
  if (typeof max === 'number' && typeof min === 'number') {
    segments.push({
      id: 'hilo',
      label: 'H/L',
      value: `${Math.round(max)}°/${Math.round(min)}°`,
      defaultEnabled: false,
    })
  }

  // 降水確率 (今日の最大、例: "60%")。percent で bar も出す。既定 OFF。
  const pop = data.daily?.precipitation_probability_max?.[0]
  if (typeof pop === 'number') {
    const p = Math.round(pop)
    segments.push({ id: 'pop', label: 'Rain', value: `${p}%`, percent: p, defaultEnabled: false })
  }

  // 風速 (例: "4m/s")。既定 OFF。
  if (typeof cur.wind_speed_10m === 'number') {
    segments.push({
      id: 'wind',
      label: 'Wind',
      value: `${Math.round(cur.wind_speed_10m)}${windLabel}`,
      defaultEnabled: false,
    })
  }

  return { id: 'weather', label, segments }
}
