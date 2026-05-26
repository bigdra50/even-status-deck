// builtin local ソース: 時刻/日付/G2 電池を client 算出し、server と同じ StatusDoc 形で返す。
// (旧 HUD。これにより HUD も 1 つの group として並べ替え・ON/OFF 対象になる)
import { getGlassBattery } from './device-state'
import type { Segment, StatusDoc } from './status-types'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
type DateOrder = 'mdy' | 'dmy' | 'ymd'

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

function timeDate(): { time: string; date: string } {
  const now = new Date()
  const { hour12, order } = profile()
  let h = now.getHours()
  let suffix = ''
  if (hour12) {
    suffix = h < 12 ? ' AM' : ' PM'
    h = h % 12 || 12
  }
  const time = `${hour12 ? String(h) : pad2(h)}:${pad2(now.getMinutes())}${suffix}`
  const mo = now.getMonth() + 1
  const da = now.getDate()
  const num =
    order === 'ymd' ? `${pad2(mo)}-${pad2(da)}` : order === 'dmy' ? `${da}/${mo}` : `${mo}/${da}`
  return { time, date: `${WEEKDAYS[now.getDay()]} ${num}` }
}

// builtin local の StatusDoc。group "hud" に time/date(空ラベル=値のみ)/g2 電池。
export function localStatus(): StatusDoc {
  const { time, date } = timeDate()
  const { level, charging } = getGlassBattery()
  const segments: Segment[] = [
    { id: 'time', label: '', value: time, defaultEnabled: true },
    { id: 'date', label: '', value: date, defaultEnabled: true },
  ]
  if (level != null) {
    segments.push({
      id: 'g2',
      label: 'G2',
      value: `${level}%${charging ? '+' : ''}`,
      percent: level,
      defaultEnabled: true,
    })
  }
  return { version: 1, ts: Date.now(), groups: [{ id: 'hud', label: '', segments }] }
}
