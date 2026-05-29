// builtin local ソース: 時刻/日付/G2 電池を client 算出し、server と同じ StatusDoc 形で返す。
// 意味単位の 2 group (clock / g2) として返し、各 group/segment は並べ替え・ON/OFF・条件の対象になる。
import { formatEta, formatRate, getBatteryDrainRate } from './battery'
import { BUILTIN_SOURCE_ID, type Config } from './config'
import { getGlassBattery } from './device-state'
import type { Group, Segment, StatusDoc } from './status-types'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
type DateOrder = 'mdy' | 'dmy' | 'ymd'

// clock は単一 segment (id='datetime')。表示は Time 部 + Date 部を合成した 1 つのフォーマット
// 文字列で表現し SegCfg.format に保存する。Time/Date それぞれ独立に選択 (none で片方のみ)。
// 例: composeClockFormat('h:mm A','ddd MM-DD','time') = 'h:mm A  ddd MM-DD'。
export const CLOCK_SEG = 'datetime'
const CLOCK_SEP = '  ' // Time 部と Date 部の区切り (2 スペース。各部内は単一スペース)
export type ClockOrder = 'time' | 'date' // どちらを先に出すか
export type ClockOpt = { format: string; label: string }
// Time プリセット。秒付き (HH:mm:ss) を選ぶと glass tick が毎秒になる
// (scheduleGlassClock が clockShowsSeconds で粒度を切替。content-diff/store 非経由は維持)。
export const CLOCK_TIME_OPTS: ClockOpt[] = [
  { format: '', label: 'Off' },
  { format: 'HH:mm', label: '14:25 (24h)' },
  { format: 'HH:mm:ss', label: '14:25:03 (24h, sec)' },
  { format: 'h:mm A', label: '2:25 PM (12h)' },
  { format: 'h:mm:ss A', label: '2:25:03 PM (12h, sec)' },
]
// Date プリセット (区切り / 年 / 月名 / 曜日 / 順序のバリエーション)。
export const CLOCK_DATE_OPTS: ClockOpt[] = [
  { format: '', label: 'Off' },
  { format: 'MM-DD', label: '05-29' },
  { format: 'MM/DD', label: '05/29' },
  { format: 'DD-MM', label: '29-05' },
  { format: 'DD/MM', label: '29/05' },
  { format: 'ddd MM-DD', label: 'Thu 05-29' },
  { format: 'MMM DD', label: 'May 29' },
  { format: 'ddd MMM DD', label: 'Thu May 29' },
  { format: 'YYYY-MM-DD', label: '2026-05-29' },
  { format: 'YY/MM/DD', label: '26/05/29' },
  { format: 'MM/DD/YYYY', label: '05/29/2026' },
  { format: 'DD/MM/YYYY', label: '29/05/2026' },
]

// Time 部 + Date 部 + 順序 → 単一フォーマット文字列。空の部分は省く。
export function composeClockFormat(time: string, date: string, order: ClockOrder): string {
  const parts = order === 'date' ? [date, time] : [time, date]
  return parts.filter(Boolean).join(CLOCK_SEP)
}
// 合成フォーマットを Time/Date/順序 に逆解析する (UI 復元用)。':' を含む部分が Time。
export function parseClockFormat(fmt: string): { time: string; date: string; order: ClockOrder } {
  const parts = fmt
    .split(CLOCK_SEP)
    .map((s) => s.trim())
    .filter(Boolean)
  let time = ''
  let date = ''
  for (const p of parts) {
    if (p.includes(':')) time = p
    else date = p
  }
  const order: ClockOrder = parts.length === 2 && !parts[0]?.includes(':') ? 'date' : 'time'
  return { time, date, order }
}

// 端末ロケールから 12/24h と日付順を判定する純粋関数 (テスト可能)。
export function formatProfile(locale: string | undefined): { hour12: boolean; order: DateOrder } {
  try {
    const hc = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle
    const hour12 = hc === 'h11' || hc === 'h12'
    const parts = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(new Date(2000, 0, 2))
    const first = parts.find(
      (p) => p.type === 'year' || p.type === 'month' || p.type === 'day',
    )?.type
    const order: DateOrder = first === 'year' ? 'ymd' : first === 'day' ? 'dmy' : 'mdy'
    return { hour12, order }
  } catch {
    return { hour12: false, order: 'mdy' }
  }
}

let cachedProfile: { hour12: boolean; order: DateOrder } | null = null
function profile(): { hour12: boolean; order: DateOrder } {
  if (!cachedProfile) {
    const loc = (typeof navigator !== 'undefined' ? navigator.language : undefined) || undefined
    cachedProfile = formatProfile(loc)
  }
  return cachedProfile
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ロケール既定の合成フォーマット (SegCfg.format 未設定時)。
export function defaultClockFormat(): string {
  const { hour12, order } = profile()
  const t = hour12 ? 'h:mm A' : 'HH:mm'
  const d = order === 'ymd' ? 'YYYY-MM-DD' : 'ddd MM-DD'
  return composeClockFormat(t, d, 'time')
}

// フォーマット文字列を現在時刻で展開する。トークン: YYYY/YY/MMM/HH(24h)/MM/DD/mm/ss/A(AM-PM)/h(12h)/ddd。
// 'h' は常に 12 時間制 (1-12)、'HH' は常に 24 時間制。12/24h はフォーマット側で決まる (ロケール非依存)。
// 接頭辞衝突を避ける順: YYYY→YY, MMM→MM, HH→h, ddd は出力に h/d を含むため最後。
// ss は小文字 s のみで他トークンの出力 (月名/曜日/AM-PM) に現れないため位置は自由 (mm の後)。
function formatClock(d: Date, fmt: string): string {
  const h24 = d.getHours()
  const h12 = h24 % 12 || 12
  let s = fmt
  s = s.replaceAll('YYYY', String(d.getFullYear()))
  s = s.replaceAll('YY', pad2(d.getFullYear() % 100))
  s = s.replaceAll('MMM', MONTHS[d.getMonth()] ?? '')
  s = s.replaceAll('HH', pad2(h24))
  s = s.replaceAll('MM', pad2(d.getMonth() + 1))
  s = s.replaceAll('DD', pad2(d.getDate()))
  s = s.replaceAll('mm', pad2(d.getMinutes()))
  s = s.replaceAll('ss', pad2(d.getSeconds()))
  s = s.replaceAll('A', h24 < 12 ? 'AM' : 'PM')
  s = s.replaceAll('h', String(h12))
  s = s.replaceAll('ddd', WEEKDAYS[d.getDay()] ?? '')
  return s
}

// フォーマットの表示幅 (最大桁数)。等幅近似の枠確保/省略用。2 桁時刻・月名 3 字を含む広めの
// サンプルで測る (h は 22 時で 2 桁、MMM/ddd は 3 字固定)。
const WIDE_SAMPLE = new Date(2026, 11, 24, 22, 38)
function clockFormatWidth(fmt: string): number {
  return formatClock(WIDE_SAMPLE, fmt).length
}

// clock segment が秒トークン (ss) を含むか。glass tick の粒度判定に使う (glass.ts)。
// format 未設定はロケール既定 (秒なし) を見るので false。
export function clockShowsSeconds(cfg?: Config): boolean {
  const stored = cfg?.groups[BUILTIN_SOURCE_ID]?.clock?.segments.find(
    (s) => s.id === CLOCK_SEG,
  )?.format
  const fmt = stored?.length ? stored : defaultClockFormat()
  return fmt.includes('ss')
}

// clock segment (単一)。SegCfg.format があればそれ、無ければロケール既定で整形。
function clockSegment(cfg?: Config): Segment {
  const stored = cfg?.groups[BUILTIN_SOURCE_ID]?.clock?.segments.find(
    (s) => s.id === CLOCK_SEG,
  )?.format
  const fmt = stored?.length ? stored : defaultClockFormat()
  return {
    id: CLOCK_SEG,
    label: '',
    value: formatClock(new Date(), fmt),
    defaultEnabled: true,
    widthChars: clockFormatWidth(fmt),
    isNumeric: false,
  }
}

// builtin local の StatusDoc。意味単位で 2 group に分ける:
//   clock: time/date (時計。glass は値のみ)
//   g2:    level/rate/eta (G2 電池。充電中/データ不足で rate/eta は出さない = segment 不在で非描画)
// group.label / segment.label は glass 向けの短縮。companion 側は config.ts の
// BUILTIN_GROUP_LABELS / BUILTIN_SEG_LABELS で説明的なラベルに置き換えて表示する
// (glass は狭いので compact、companion は分かりやすく、を両立する)。
export function localStatus(config?: Config): StatusDoc {
  const { level, charging } = getGlassBattery()
  // clock group は単一 segment (Time/Date を合成した 1 つ)。SegCfg.format で表示を制御。
  const groups: Group[] = [{ id: 'clock', label: '', segments: [clockSegment(config)] }]
  if (level != null) {
    const battery: Segment[] = [
      {
        id: 'level',
        label: 'Bat',
        value: `${level}%${charging ? '+' : ''}`,
        percent: level,
        defaultEnabled: true,
        widthChars: 5, // '100%+'
        isNumeric: true,
      },
    ]
    const rate = getBatteryDrainRate(charging) // 充電中/データ不足は null
    const r = formatRate(rate)
    if (r) battery.push({ id: 'rate', label: '', value: r, defaultEnabled: true, widthChars: 7 }) // '↓100%/h'
    const eta = formatEta(rate)
    if (eta)
      battery.push({ id: 'eta', label: 'Left', value: eta, defaultEnabled: true, widthChars: 6 }) // '23h59m'
    groups.push({ id: 'g2', label: '', segments: battery })
  }
  return { version: 1, ts: Date.now(), groups }
}
