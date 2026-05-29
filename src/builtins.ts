// builtin local ソース: 時刻/日付/G2 電池を client 算出し、server と同じ StatusDoc 形で返す。
// 意味単位の 2 group (clock / g2) として返し、各 group/segment は並べ替え・ON/OFF・条件の対象になる。
import { formatEta, formatRate, getBatteryDrainRate } from './battery'
import { BUILTIN_SOURCE_ID, type Config } from './config'
import { getGlassBattery } from './device-state'
import type { Group, Segment, StatusDoc } from './status-types'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
type DateOrder = 'mdy' | 'dmy' | 'ymd'

// clock segment (time/date/datetime) の表示フォーマットプリセット。
// format = トークン文字列 (SegCfg.format に直接保存)。width = glass 表示枠 (最大桁数)。
// kind = どの segment 用か。label = dropdown 表示例。
export type ClockKind = 'time' | 'date' | 'datetime'
export type ClockPreset = { kind: ClockKind; format: string; label: string; width: number }
export const CLOCK_PRESETS: ClockPreset[] = [
  { kind: 'time', format: 'HH:mm', label: '14:25', width: 5 },
  { kind: 'time', format: 'h:mm A', label: '2:25 PM', width: 8 },
  { kind: 'date', format: 'MM-DD', label: '05-29', width: 5 },
  { kind: 'date', format: 'ddd MM-DD', label: 'Thu 05-29', width: 9 },
  { kind: 'date', format: 'YYYY-MM-DD', label: '2026-05-29', width: 10 },
  { kind: 'datetime', format: 'HH:mm ddd MM-DD', label: '14:25 Thu 05-29', width: 15 },
  { kind: 'datetime', format: 'h:mm A ddd MM-DD', label: '2:25 PM Thu 05-29', width: 18 },
]
const CLOCK_KIND: Record<string, ClockKind> = { time: 'time', date: 'date', datetime: 'datetime' }

export function clockPresetsForSeg(segId: string): ClockPreset[] {
  const k = CLOCK_KIND[segId]
  return k ? CLOCK_PRESETS.filter((p) => p.kind === k) : []
}
function clockPreset(format: string): ClockPreset | undefined {
  return CLOCK_PRESETS.find((p) => p.format === format)
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

// segId のロケール既定フォーマット (SegCfg.format 未設定時)。
export function defaultClockFormat(segId: string): string {
  const { hour12, order } = profile()
  if (segId === 'time') return hour12 ? 'h:mm A' : 'HH:mm'
  if (segId === 'date') return order === 'ymd' ? 'YYYY-MM-DD' : 'ddd MM-DD'
  if (segId === 'datetime') return hour12 ? 'h:mm A ddd MM-DD' : 'HH:mm ddd MM-DD'
  return 'HH:mm'
}

// フォーマット文字列を現在時刻で展開する。トークン: YYYY/HH(24h)/MM/DD/mm/A(AM-PM)/h(12h)/ddd。
// 'h' は常に 12 時間制 (1-12)、'HH' は常に 24 時間制。12/24h はフォーマット側で決まる (ロケール非依存)。
// ddd (曜日名) は最後に置換する (出力に h/d 等を含むため、単独トークン置換より後)。
function formatClock(d: Date, fmt: string): string {
  const h24 = d.getHours()
  const h12 = h24 % 12 || 12
  let s = fmt
  s = s.replaceAll('YYYY', String(d.getFullYear()))
  s = s.replaceAll('HH', pad2(h24))
  s = s.replaceAll('MM', pad2(d.getMonth() + 1))
  s = s.replaceAll('DD', pad2(d.getDate()))
  s = s.replaceAll('mm', pad2(d.getMinutes()))
  s = s.replaceAll('A', h24 < 12 ? 'AM' : 'PM')
  s = s.replaceAll('h', String(h12))
  s = s.replaceAll('ddd', WEEKDAYS[d.getDay()] ?? '')
  return s
}

// clock segment を生成する。SegCfg.format があればそれ、無ければロケール既定で整形。
// widthChars はプリセット幅 (枠確保/省略用)。clock は左寄せ (isNumeric=false)。
function clockSegment(id: string, now: Date, cfg?: Config): Segment {
  const fmt = cfg?.groups[BUILTIN_SOURCE_ID]?.clock?.segments.find((s) => s.id === id)?.format
  const effective = fmt && clockPreset(fmt) ? fmt : defaultClockFormat(id)
  return {
    id,
    label: '',
    value: formatClock(now, effective),
    defaultEnabled: id !== 'datetime', // datetime は opt-in
    widthChars: clockPreset(effective)?.width,
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
  const now = new Date()
  const { level, charging } = getGlassBattery()
  // clock group: time/date は既定 ON、datetime (結合) は opt-in。各 segment は SegCfg.format に従う。
  const clock: Segment[] = [
    clockSegment('time', now, config),
    clockSegment('date', now, config),
    clockSegment('datetime', now, config),
  ]
  const groups: Group[] = [{ id: 'clock', label: '', segments: clock }]
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
