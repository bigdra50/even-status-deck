// client source: companion WebView の geolocation で現在地を取り、open-meteo(キー不要)から
// 現在の気象を取得して StatusDoc(weather group)を返す。glass/companion は store 経由で購読する。
//
// 設計(codex と確定): 位置は WebView 側にしか無い(SDK に GPS 無し)。座標は丸めてプライバシーを抑え、
// localStorage に TTL キャッシュして open-meteo を高頻度に叩かない。store の poll(60s)から呼ばれるが、
// fresh(30分)の間は geolocation も network も呼ばず cache を返す。失敗時は stale(6時間)→error と degrade。
// glass の tofu を避けるため値は ASCII のみ(絵文字を使わない)。
//
// #38(静的 sun)/#40(拡張 segment + 単位 options): 同一 open-meteo リクエストに daily(sunrise/sunset)と
// 追加 current(体感/湿度/風向/UV/気圧)+ hourly(気圧トレンド)を相乗りさせ、別 source を増やさない。
// 単位/フォーマットは source 単位の表示オプション(#36 基盤の SourceDef.options)で選び、producer へ渡す。
import { formatProfile } from './builtins'
import type { OptionValues } from './config'
import { getRoundedPosition } from './geo-position'
import {
  type Group,
  parseStatusDoc,
  type Segment,
  type SourceState,
  type StatusDoc,
} from './status-types'
import {
  type GeoCacheEntry,
  isCacheFresh,
  isCacheStaleOk,
  readGeoCache,
  writeGeoCache,
} from './ttl-cache'

export const WEATHER_GROUP_ID = 'weather'

const CACHE_KEY = 'toolbar.weather.cache'
const FRESH_MS = 30 * 60_000 // この間は再取得しない(cache をそのまま返す)
const STALE_MAX_MS = 6 * 60 * 60_000 // 失敗時に cache を stale 表示してよい上限
const OPEN_METEO_TIMEOUT_MS = 8_000 // fetch がハングして weather が永遠に pending(灰色)になるのを防ぐ

// source 単位の表示オプション(#40)。値の永続は SourceDef.options、スキーマ宣言は options.ts。
// producer はここで型へ解決し、URL のクエリパラメータと segment 整形に反映する。
export type WeatherOptions = {
  tempUnit: 'C' | 'F'
  windUnit: 'kmh' | 'ms' | 'mph'
  windDir: 'text' | 'arrow'
  presUnit: 'hPa' | 'inHg'
  stormSensitivity: 'low' | 'normal' | 'high'
  sunFormat: 'auto' | '24h' | '12h' // 'auto' は producer 内でロケールから 24h/12h へ解決
  // #39 降水ナウキャスト。rainin segment の表示モード + しきい値(降水とみなす mm)+ 取得粒度。
  rainMode: 'nextrain' | '1hchance' | 'recent'
  rainThreshold: number // wetMm: これ以上を降水とみなす(既定 0.1mm)
  rainGranularity: 'auto' | 'hourly' // auto = minutely_15 優先(取れなければ hourly)
}

export const DEFAULT_WEATHER_OPTIONS: WeatherOptions = {
  tempUnit: 'C',
  windUnit: 'kmh',
  windDir: 'text',
  presUnit: 'hPa',
  stormSensitivity: 'normal',
  sunFormat: 'auto',
  rainMode: 'nextrain',
  rainThreshold: 0.1,
  rainGranularity: 'auto',
}

// 永続バッグ(string|number|boolean)を型付き WeatherOptions へ防御的に解決する。
// 未設定/不正値は既定へフォールバック(store は #36 基盤で sanitize 済みだが weather 単体でも安全に)。
export function readWeatherOptions(bag: OptionValues | undefined): WeatherOptions {
  const pick = <T extends string>(key: string, allowed: readonly T[], dflt: T): T => {
    const v = bag?.[key]
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt
  }
  const pickNum = (key: string, min: number, max: number, dflt: number): number => {
    const v = bag?.[key]
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
  }
  return {
    tempUnit: pick('tempUnit', ['C', 'F'] as const, 'C'),
    windUnit: pick('windUnit', ['kmh', 'ms', 'mph'] as const, 'kmh'),
    windDir: pick('windDir', ['text', 'arrow'] as const, 'text'),
    presUnit: pick('presUnit', ['hPa', 'inHg'] as const, 'hPa'),
    stormSensitivity: pick('stormSensitivity', ['low', 'normal', 'high'] as const, 'normal'),
    sunFormat: pick('sunFormat', ['auto', '24h', '12h'] as const, 'auto'),
    rainMode: pick('rainMode', ['nextrain', '1hchance', 'recent'] as const, 'nextrain'),
    rainThreshold: pickNum('rainThreshold', 0, 5, 0.1),
    rainGranularity: pick('rainGranularity', ['auto', 'hourly'] as const, 'auto'),
  }
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

// 風向(度)→ 8 方位の ASCII テキスト。0=N, 時計回り。負値/360 超も正規化する。
export function windDir8(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const norm = ((deg % 360) + 360) % 360
  return dirs[Math.round(norm / 45) % 8]
}

// 風向(度)→ 矢印グリフ(opt-in)。実機フォントに矢印が無いと tofu になるため既定は text。
const WIND_ARROWS: Record<string, string> = {
  N: '↑',
  NE: '↗',
  E: '→',
  SE: '↘',
  S: '↓',
  SW: '↙',
  W: '←',
  NW: '↖',
}

function windDirValue(deg: number, mode: 'text' | 'arrow'): string {
  const text = windDir8(deg)
  return mode === 'arrow' ? (WIND_ARROWS[text] ?? text) : text
}

// hPa → inHg(水銀柱インチ)。open-meteo は気圧の単位指定が無いため producer 側で換算する。
export function hpaToInHg(hpa: number): number {
  return hpa * 0.0295299830714
}

// 3 時間の気圧変化量(hPa)→ 荒天前兆ラベル。sensitivity が「急変」しきい値(low=4/normal=3/high=2 hPa)。
// 気圧の急降下(低気圧接近)を早期警戒として glass に出す。値は ASCII のみ。
export function pressureTrend(deltaHpa: number, sensitivity: 'low' | 'normal' | 'high'): string {
  const strong = sensitivity === 'low' ? 4 : sensitivity === 'high' ? 2 : 3
  if (deltaHpa <= -strong) return 'Fall fast'
  if (deltaHpa <= -1) return 'Falling'
  if (deltaHpa < 1) return 'Steady'
  if (deltaHpa < strong) return 'Rising'
  return 'Rise fast'
}

// open-meteo の現地時刻 ISO(例 "2026-05-31T04:25")から HH:mm を取り出して整形する。
// Date を介さず文字列から取るので端末 TZ に依存しない(open-meteo timezone=auto = 現地時刻が前提)。
export function formatSunTime(iso: string, hour12: boolean): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return 'n/a'
  const hh = Number(m[1])
  const mm = m[2]
  if (!hour12) return `${m[1]}:${mm}`
  const ap = hh < 12 ? 'a' : 'p'
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${h12}:${mm}${ap}`
}

function isoToMinutes(iso: string): number | null {
  const m = /T(\d{2}):(\d{2})/.exec(iso)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// 日の出→日の入りの昼の長さ "14h36m"。日跨ぎ(set < rise)は 24h を足して正の長さにする。
export function formatDayLength(sunriseIso: string, sunsetIso: string): string {
  const r = isoToMinutes(sunriseIso)
  const s = isoToMinutes(sunsetIso)
  if (r == null || s == null) return 'n/a'
  let diff = s - r
  if (diff < 0) diff += 24 * 60
  return `${Math.floor(diff / 60)}h${String(diff % 60).padStart(2, '0')}m`
}

function tempUnitLabel(u: 'C' | 'F'): string {
  return u
}

function windUnitLabel(u: 'kmh' | 'ms' | 'mph'): string {
  return u === 'kmh' ? 'km/h' : u === 'ms' ? 'm/s' : 'mph'
}

function pressureValue(hpa: number, unit: 'hPa' | 'inHg'): string {
  return unit === 'inHg' ? `${hpaToInHg(hpa).toFixed(2)}inHg` : `${Math.round(hpa)}hPa`
}

// rainin segment の value を mode で切替。データが無いモードは undefined(segment を出さない)。
function raininValue(r: WeatherReading, mode: WeatherOptions['rainMode']): string | undefined {
  if (mode === '1hchance')
    return typeof r.pop1h === 'number' ? `${Math.round(r.pop1h)}%` : undefined
  if (mode === 'recent')
    return typeof r.precip1h === 'number' ? `${r.precip1h.toFixed(1)}mm` : undefined
  return r.rainLabel
}

// producer が組み立てた素の気象読み取り。単位は openMeteoUrl のクエリで既に要求単位(temp/wind)で返る。
// 追加(#40/#38)は欠落し得るため optional。欠落フィールドの segment は push しない。
export type WeatherReading = {
  temp: number // 要求された温度単位の値(opts.tempUnit)
  code: number
  wind: number // 要求された風速単位の値(opts.windUnit)
  feels?: number
  humidity?: number
  windDeg?: number
  uv?: number
  pressureHpa?: number
  pressureDelta3h?: number
  sunriseIso?: string
  sunsetIso?: string
  // #39 降水ナウキャスト(producer が minutely_15/hourly から算出)。降水データが無ければ undefined。
  rainLabel?: string // 'Rain ~20m' / 'Stops ~10m' / 'Dry' / 'Rain'(降り続く)
  pop1h?: number // 次 1 時間の降水確率 max (%)
  precip1h?: number // 次 1 時間の降水量合計 (mm)
  // #38 suncountdown: 日の出/日の入りの epoch(ms)。glass が毎分カウントダウンを再計算する anchor。
  sunEpochs?: { sunrise: number; sunset: number; nextSunrise: number }
}

// suncountdown の残り時間 ASCII。1h 以上 "2h13m"、1h 未満 "47m"、1 分未満 "now"。
export function formatEta(ms: number): string {
  if (ms < 60_000) return 'now' // 1 分未満(過ぎている=負も含む)
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`
}

// 現在時刻と sun epoch から「次の日没/日の出までの残り」を出す(#38)。glass が毎分呼ぶ純計算。
// 日の出前=次は日の出(Rise)、昼=次は日没(Set)、日没後=翌日の日の出(Rise)。
export function formatSunCountdown(
  now: number,
  e: {
    sunrise: number
    sunset: number
    nextSunrise: number
  },
): string {
  if (now < e.sunrise) return `Rise ${formatEta(e.sunrise - now)}`
  if (now < e.sunset) return `Set ${formatEta(e.sunset - now)}`
  return `Rise ${formatEta(e.nextSunrise - now)}`
}

// 降水スロット 1 点。min = 現在からの相対分(負=過去)。precip=mm、prob=%。
export type PrecipSlot = { min: number; precip: number; prob: number }

function round5(n: number): number {
  return Math.max(5, Math.round(n / 5) * 5)
}

// 降水スロット列 →「次の降雨/降り止み/Dry」ラベル(ASCII)。wetMm 以上を降水とみなす。
// 「現在」= 直近の過去スロット(あれば)、無ければ最初の未来スロット。ETA は未来スロットのみ使う
// (過去スロットを ETA に混入させない)。未来予報が無ければ undefined(segment を出さない)。
// 時刻粒度: hourly か、minutely でも 60 分以上は ~Nh(widthChars=10 に収めるため。例 "Stops ~24h"=10)。
export function rainNowcastLabel(
  slots: PrecipSlot[],
  wetMm: number,
  granularity: 'minutely' | 'hourly',
): string | undefined {
  const sorted = [...slots].sort((a, b) => a.min - b.min)
  const future = sorted.filter((s) => s.min >= 0)
  if (!future.length) return undefined
  const past = sorted.filter((s) => s.min < 0)
  const current = past.length ? past[past.length - 1] : future[0]
  const eta = (min: number): string =>
    granularity === 'hourly' || min >= 60
      ? `~${Math.max(1, Math.round(min / 60))}h`
      : `~${round5(min)}m`
  if (current.precip >= wetMm) {
    const dry = future.find((s) => s.precip < wetMm)
    return dry ? `Stops ${eta(dry.min)}` : 'Rain' // 窓内に止む予報なし=降り続く
  }
  const wet = future.find((s) => s.precip >= wetMm)
  return wet ? `Rain ${eta(wet.min)}` : 'Dry'
}

// 次 1 時間(min∈[0,60))の降水確率 max(%)。窓内スロットが無ければ undefined。
export function pop1hMax(slots: PrecipSlot[]): number | undefined {
  const win = slots.filter((s) => s.min >= 0 && s.min < 60)
  return win.length ? Math.max(...win.map((s) => s.prob)) : undefined
}

// 次 1 時間(min∈[0,60))の降水量合計(mm)。窓内スロットが無ければ undefined。
export function precip1hSum(slots: PrecipSlot[]): number | undefined {
  const win = slots.filter((s) => s.min >= 0 && s.min < 60)
  return win.length ? win.reduce((sum, s) => sum + s.precip, 0) : undefined
}

// 気象読み取りから weather group の StatusDoc を組む。temp/cond は既定 ON、それ以外は既定 OFF。
// opts は単位/フォーマット選択(producer で 'auto' は解決済み = sunFormat は '24h'|'12h')。
export function buildWeatherDoc(
  r: WeatherReading,
  opts: WeatherOptions,
  ts: number,
  state?: SourceState,
  message?: string,
): StatusDoc {
  const hour12 = opts.sunFormat === '12h'
  const segments: Segment[] = [
    {
      id: 'temp',
      label: '',
      value: `${Math.round(r.temp)}${tempUnitLabel(opts.tempUnit)}`, // ASCII のみ (° は tofu になり得る)
      defaultEnabled: true,
      widthChars: 4,
      isNumeric: true,
    },
    { id: 'cond', label: '', value: weatherCodeText(r.code), defaultEnabled: true, widthChars: 9 },
    {
      id: 'wind',
      label: 'Wind',
      value: `${Math.round(r.wind)}${windUnitLabel(opts.windUnit)}`,
      defaultEnabled: false,
      widthChars: 8,
    },
  ]

  // #39 降水ナウキャスト。rainin は既定 ON(視線を上げた一瞬で「もうすぐ降る/止む」が分かる)。
  // mode で rainin の表示を切替。pop1h/precip1h は既定 OFF の専用 segment。降水データ欠落時は出さない。
  const rv = raininValue(r, opts.rainMode)
  if (rv !== undefined) {
    segments.push({ id: 'rainin', label: '', value: rv, defaultEnabled: true, widthChars: 10 })
  }
  if (typeof r.pop1h === 'number') {
    segments.push({
      id: 'pop1h',
      label: 'Rain',
      value: `${Math.round(r.pop1h)}%`,
      defaultEnabled: false,
      widthChars: 4,
      isNumeric: true,
    })
  }
  if (typeof r.precip1h === 'number') {
    segments.push({
      id: 'precip1h',
      label: 'Wet',
      value: `${r.precip1h.toFixed(1)}mm`,
      defaultEnabled: false,
      widthChars: 6,
      isNumeric: true,
    })
  }

  // #40 拡張 segment(すべて既定 OFF / opt-in)。欠落フィールドは push しない。
  if (typeof r.feels === 'number') {
    segments.push({
      id: 'feels',
      label: 'Feel',
      value: `${Math.round(r.feels)}${tempUnitLabel(opts.tempUnit)}`,
      defaultEnabled: false,
      widthChars: 7,
      isNumeric: true,
    })
  }
  if (typeof r.humidity === 'number') {
    segments.push({
      id: 'humid',
      label: 'Hum',
      value: `${Math.round(r.humidity)}%`,
      defaultEnabled: false,
      widthChars: 7,
      isNumeric: true,
    })
  }
  if (typeof r.windDeg === 'number') {
    segments.push({
      id: 'wdir',
      label: 'Wind',
      value: windDirValue(r.windDeg, opts.windDir),
      defaultEnabled: false,
      widthChars: 7,
    })
  }
  if (typeof r.uv === 'number') {
    segments.push({
      id: 'uv',
      label: 'UV',
      value: `${Math.round(r.uv)}`,
      defaultEnabled: false,
      widthChars: 5,
      isNumeric: true,
    })
  }
  if (typeof r.pressureHpa === 'number') {
    segments.push({
      id: 'pres',
      label: '',
      // inHg は常に "XX.XXinHg"=9 桁 (hPa は最大 "1084hPa"=7 桁)。両単位が収まるよう 9 にする。
      value: pressureValue(r.pressureHpa, opts.presUnit),
      defaultEnabled: false,
      widthChars: 9,
      isNumeric: true,
    })
  }
  if (typeof r.pressureDelta3h === 'number') {
    segments.push({
      id: 'ptrend',
      label: 'Baro',
      value: pressureTrend(r.pressureDelta3h, opts.stormSensitivity),
      defaultEnabled: false,
      widthChars: 10,
    })
  }

  // #38 静的 sun segment(既定 OFF)。daily が取れたときのみ。
  if (r.sunriseIso && r.sunsetIso) {
    segments.push({
      id: 'sunrise',
      label: 'Rise',
      value: formatSunTime(r.sunriseIso, hour12),
      defaultEnabled: false,
      widthChars: 5,
    })
    segments.push({
      id: 'sunset',
      label: 'Set',
      value: formatSunTime(r.sunsetIso, hour12),
      defaultEnabled: false,
      widthChars: 5,
    })
    segments.push({
      id: 'daylength',
      label: 'Day',
      value: formatDayLength(r.sunriseIso, r.sunsetIso),
      defaultEnabled: false,
      widthChars: 6,
    })
  }

  const group: Group = { id: WEATHER_GROUP_ID, label: 'Weather', segments }
  // #38 suncountdown(既定 ON): 値は描画時刻依存なので glass が anchors から毎分再計算する。ここでは初期値を焼く。
  if (r.sunEpochs) {
    group.anchors = { ...r.sunEpochs }
    segments.push({
      id: 'suncountdown',
      label: '',
      // 最長 "Rise 23h59m"=11 桁(Set 4+eta 6 / Rise 5+eta 6)。9 だと長い eta が切れる。
      value: formatSunCountdown(ts, r.sunEpochs),
      defaultEnabled: true,
      widthChars: 11,
    })
  }
  if (state) group.state = state
  if (message) group.message = message
  return { version: 1, ts, groups: [group] }
}

// glass が毎分呼ぶ: weather doc の suncountdown segment 値を group.anchors から現在時刻で再計算した
// 新 doc を返す(anchors/suncountdown が無ければそのまま)。store の doc は変更せず clone を返す
// (= store.notify/computeVisible を介さない glass-local 再計算。iOS WebContent jettison を避ける)。
export function recomputeSunCountdown(doc: StatusDoc, now: number): StatusDoc {
  const g = doc.groups.find((x) => x.id === WEATHER_GROUP_ID)
  const e = g?.anchors
  if (
    !g ||
    !e ||
    typeof e.sunrise !== 'number' ||
    typeof e.sunset !== 'number' ||
    typeof e.nextSunrise !== 'number'
  ) {
    return doc
  }
  if (!g.segments.some((s) => s.id === 'suncountdown')) return doc
  const value = formatSunCountdown(now, {
    sunrise: e.sunrise,
    sunset: e.sunset,
    nextSunrise: e.nextSunrise,
  })
  return {
    ...doc,
    groups: doc.groups.map((gr) =>
      gr.id !== WEATHER_GROUP_ID
        ? gr
        : {
            ...gr,
            segments: gr.segments.map((s) => (s.id !== 'suncountdown' ? s : { ...s, value })),
          },
    ),
  }
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

// cache は単位/フォーマット選択(optSig)込みで保持する。option を変えたら fresh でも再取得して即反映する。
type Cache = GeoCacheEntry<StatusDoc>

function optSig(opts: WeatherOptions): string {
  return [
    opts.tempUnit,
    opts.windUnit,
    opts.windDir,
    opts.presUnit,
    opts.stormSensitivity,
    opts.sunFormat,
    opts.rainMode,
    String(opts.rainThreshold),
    opts.rainGranularity,
  ].join('|')
}

// open-meteo の現在天気 URL。外部 fetch 先を限定するため host は api.open-meteo.com 固定。
// 単位は opts のクエリパラメータで正確に取得する(temp/wind)。daily/hourly で sun と気圧トレンド素材も取る。
export function openMeteoUrl(
  lat: number,
  lon: number,
  opts: WeatherOptions = DEFAULT_WEATHER_OPTIONS,
): string {
  const tempUnit = opts.tempUnit === 'F' ? 'fahrenheit' : 'celsius'
  const windSpeedUnit = opts.windUnit === 'ms' ? 'ms' : opts.windUnit === 'mph' ? 'mph' : 'kmh'
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,weather_code,wind_speed_10m,apparent_temperature,' +
    'relative_humidity_2m,wind_direction_10m,uv_index,surface_pressure' +
    '&daily=sunrise,sunset' +
    // hourly: 気圧トレンド(past 3h)+ 降水ナウキャストの hourly フォールバック(forecast 12h)。
    '&hourly=surface_pressure,precipitation,precipitation_probability&past_hours=3&forecast_hours=12' +
    // minutely_15: 降水ナウキャストの高粒度素材(次 24h=96 スロット)。地域により空のことがある。
    '&minutely_15=precipitation,precipitation_probability&forecast_minutely_15=96' +
    `&temperature_unit=${tempUnit}&wind_speed_unit=${windSpeedUnit}&timezone=auto`
  )
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function firstString(v: unknown): string | undefined {
  return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined
}

// daily.sunrise/sunset(現地時刻 ISO 配列)から suncountdown 用の epoch を取り出す(#38)。
// 今日の sunrise/sunset + 翌日の sunrise(日没後のカウントダウン基準)。いずれか欠けたら undefined。
function sunEpochsFrom(
  sunrise: unknown,
  sunset: unknown,
): { sunrise: number; sunset: number; nextSunrise: number } | undefined {
  if (!Array.isArray(sunrise) || !Array.isArray(sunset)) return undefined
  const parse = (s: unknown): number => (typeof s === 'string' ? Date.parse(s) : Number.NaN)
  const sr = parse(sunrise[0])
  const ss = parse(sunset[0])
  const nsr = parse(sunrise[1])
  if (Number.isNaN(sr) || Number.isNaN(ss) || Number.isNaN(nsr)) return undefined
  return { sunrise: sr, sunset: ss, nextSunrise: nsr }
}

// open-meteo の時刻 ISO 配列 + precip/prob 配列を相対分スロット列へ。
// Date.parse は現地時刻 ISO(timezone=auto)= 端末 TZ 前提(weather 既存の前提と同じ)。
// precip が finite number でない点(配列長不一致・null 欠落含む)は除外する。0 扱いにすると
// データ欠落が「乾燥予報」に化けて Stops/Dry/precip1h を過小評価するため。prob 欠落は副次なので 0。
export function buildPrecipSlots(
  times: unknown,
  precip: unknown,
  prob: unknown,
  nowMs: number,
): PrecipSlot[] {
  if (!Array.isArray(times) || !Array.isArray(precip)) return []
  const probArr = Array.isArray(prob) ? prob : []
  const out: PrecipSlot[] = []
  for (let i = 0; i < times.length; i++) {
    const t = times[i]
    if (typeof t !== 'string') continue
    const ms = Date.parse(t)
    if (Number.isNaN(ms)) continue
    const p = num(precip[i])
    if (p === undefined) continue // precip 欠落点は除外(乾燥扱いにしない)
    out.push({
      min: Math.round((ms - nowMs) / 60_000),
      precip: p,
      prob: num(probArr[i]) ?? 0,
    })
  }
  return out
}

// 降水ナウキャストを算出する。auto は minutely_15 優先(取れなければ hourly)。
function computePrecip(
  json: { minutely_15?: Record<string, unknown>; hourly?: Record<string, unknown> },
  opts: WeatherOptions,
  nowMs: number,
): { rainLabel?: string; pop1h?: number; precip1h?: number } {
  const m = json.minutely_15
  const h = json.hourly
  const minutelySlots = buildPrecipSlots(
    m?.time,
    m?.precipitation,
    m?.precipitation_probability,
    nowMs,
  )
  const useHourly = opts.rainGranularity === 'hourly' || minutelySlots.length === 0
  const slots = useHourly
    ? buildPrecipSlots(h?.time, h?.precipitation, h?.precipitation_probability, nowMs)
    : minutelySlots
  return {
    rainLabel: rainNowcastLabel(slots, opts.rainThreshold, useHourly ? 'hourly' : 'minutely'),
    pop1h: pop1hMax(slots),
    precip1h: precip1hSum(slots),
  }
}

// hourly.surface_pressure の最古点(=3時間前)と current の差を 3h 変化量とする。
// 単点しか取れない環境では undefined(ptrend segment を出さない)。
function pressureDelta(currentHpa: number | undefined, hourly: unknown): number | undefined {
  if (currentHpa === undefined) return undefined
  const arr = (hourly as { surface_pressure?: unknown })?.surface_pressure
  if (!Array.isArray(arr) || arr.length < 2) return undefined
  const past = num(arr[0])
  if (past === undefined) return undefined
  return currentHpa - past
}

async function fetchOpenMeteo(
  lat: number,
  lon: number,
  opts: WeatherOptions,
  signal: AbortSignal,
): Promise<WeatherReading> {
  // 外部 fetch がハングしたままだと weather が永遠に pending(灰色)になるため、timeout で abort する。
  // store からの signal(source 変更時)も合流させ、どちらでも fetch を止める。
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), OPEN_METEO_TIMEOUT_MS)
  try {
    const res = await fetch(openMeteoUrl(lat, lon, opts), { signal: ctl.signal })
    if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`)
    const json = (await res.json()) as {
      current?: Record<string, unknown>
      daily?: Record<string, unknown>
      hourly?: Record<string, unknown>
      minutely_15?: Record<string, unknown>
    }
    const cur = json.current
    if (!cur || typeof cur.temperature_2m !== 'number') {
      throw new Error('open-meteo: no current data')
    }
    const pressureHpa = num(cur.surface_pressure)
    const rain = computePrecip(json, opts, Date.now())
    return {
      temp: cur.temperature_2m,
      code: typeof cur.weather_code === 'number' ? cur.weather_code : -1,
      wind: typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : 0,
      feels: num(cur.apparent_temperature),
      humidity: num(cur.relative_humidity_2m),
      windDeg: num(cur.wind_direction_10m),
      uv: num(cur.uv_index),
      pressureHpa,
      pressureDelta3h: pressureDelta(pressureHpa, json.hourly),
      sunriseIso: firstString(json.daily?.sunrise),
      sunsetIso: firstString(json.daily?.sunset),
      sunEpochs: sunEpochsFrom(json.daily?.sunrise, json.daily?.sunset),
      rainLabel: rain.rainLabel,
      pop1h: rain.pop1h,
      precip1h: rain.precip1h,
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

// 失敗時の backoff。直近失敗から数分は geolocation/network/ログを繰り返さない (poll 毎の churn 防止)。
// in-memory (reload で解除)。fresh cache の間は元々取得しないので、これは「失敗が続く環境」専用。
const FAIL_BACKOFF_MS = 5 * 60_000
let lastFailAt = 0
let lastFailMsg = 'weather unavailable'

// 失敗/backoff 時の degrade した StatusDoc。stale cache 範囲なら最後の値、無ければ error (source は残す)。
function degraded(cache: Cache | null, now: number, msg: string): StatusDoc {
  if (isCacheStaleOk(cache, now, STALE_MAX_MS)) {
    return withState(cache.payload, 'stale', 'using cached weather')
  }
  return errorDoc(msg, now)
}

// 'auto' を端末ロケールから 24h/12h へ解決する(producer の副作用境界。buildWeatherDoc は純粋に保つ)。
function resolveSunFormat(opts: WeatherOptions): WeatherOptions {
  if (opts.sunFormat !== 'auto') return opts
  const locale = typeof navigator !== 'undefined' ? navigator.language : undefined
  return { ...opts, sunFormat: formatProfile(locale).hour12 ? '12h' : '24h' }
}

// client source の producer。store.refreshSource(kind==='client') から poll ごとに呼ばれる。
// fresh cache(同一 optSig)があれば即返し、無ければ geolocation→open-meteo を取得。失敗は stale/error に degrade。
// options(単位/フォーマット)は SourceDef.options 由来。変更時は optSig が変わり fresh でも再取得して即反映する。
export async function weatherStatus(
  signal: AbortSignal,
  options?: OptionValues,
): Promise<StatusDoc | null> {
  const opts = resolveSunFormat(readWeatherOptions(options))
  const sig = optSig(opts)
  const now = Date.now()
  // payload(doc)型ガードは parseStatusDoc。localStorage は古いバージョン/改竄で壊れ得る境界なので、
  // doc を StatusDoc 形に検証してから採用する(壊れた cache を store へ注入して描画前提を壊さない)。
  const cache = readGeoCache(CACHE_KEY, parseStatusDoc)
  // 新鮮 かつ 同一 option: 何もしない。option を変えたら fresh でも下へ進んで再取得する。
  if (isCacheFresh(cache, now, FRESH_MS, sig)) return cache.payload
  // 直近失敗の backoff 中は再取得もログもしない (poll 毎の geolocation/network/ログ churn を防ぐ)。
  if (now - lastFailAt < FAIL_BACKOFF_MS) return degraded(cache, now, lastFailMsg)
  // 実機の devtools 無し環境で経路を追えるよう、デバッグコンソールへ進捗を出す(座標は出さない=PII)。
  console.log('[weather] requesting location…')
  try {
    const { lat, lon } = await getRoundedPosition()
    if (signal.aborted) return null
    const r = await fetchOpenMeteo(lat, lon, opts, signal)
    if (signal.aborted) return null
    lastFailAt = 0 // 成功で backoff 解除
    console.log(`[weather] ok ${Math.round(r.temp)}${opts.tempUnit} ${weatherCodeText(r.code)}`)
    const doc = buildWeatherDoc(r, opts, Date.now())
    writeGeoCache(CACHE_KEY, { lat, lon, fetchedAt: Date.now(), optSig: sig, payload: doc })
    return doc
  } catch (err) {
    if (signal.aborted) return null
    lastFailMsg = err instanceof Error ? err.message : 'weather unavailable'
    lastFailAt = now // 以後 FAIL_BACKOFF_MS は再取得/ログを抑制
    console.warn(`[weather] failed: ${lastFailMsg}`)
    return degraded(cache, now, lastFailMsg)
  }
}
