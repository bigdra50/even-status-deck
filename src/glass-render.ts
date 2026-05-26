import type { Config, MachineCfg } from './config'
import type { MachineInfo } from './data'
import { getGlassBattery } from './device-state'
import type { Group, StatusDoc } from './status-types'

// glass 描画の純粋ロジック (bridge 非依存)。glass.ts が状態と bridge 配線を持ち、ここを呼ぶ。
// 表示要素は status (provider 集約) から汎用に描く。'summary' か group id がビュー。
export type GView = string
export type GlassData = {
  config: Config
  machine: MachineInfo | null
  status: StatusDoc | null
}

function groupsById(status: StatusDoc | null): Map<string, Group> {
  const m = new Map<string, Group>()
  for (const g of status?.groups ?? []) m.set(g.id, g)
  return m
}

function activeCfg(d: GlassData): MachineCfg | null {
  const id = d.config.activeMachine
  return id ? (d.config.machines[id] ?? null) : null
}

// progress bar: ━(filled) / ─(empty)。DESIGN.md §5 準拠。
export function bar(percent: number, width = 12): string {
  const p = Math.max(0, Math.min(100, percent))
  const filled = Math.round((p / 100) * width)
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

// 288px / line-height 27px ≒ 10 行。HUD を最上部、ヒントを最下端に置く。
const MAX_ROWS = 10
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// 端末ロケールから 12/24h と日付順を判定する (純粋関数, テスト可能)。
// 曜日/月名は英語維持のため Intl の名称ローカライズは使わず、数値の規約だけ採用。
type DateOrder = 'mdy' | 'dmy' | 'ymd'
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
    return { hour12: false, order: 'mdy' } // 判定不能時は 24h + M/D
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

// 最上部 HUD: 時刻 / 日付 / グラス(G2) バッテリー。時刻は WebView のシステム時計、
// 12/24h と日付順は端末ロケールに自動追従。曜日名は英語 (グラス英語方針)。
export function hudLine(): string {
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
  const date = `${WEEKDAYS[now.getDay()]} ${num}`

  const { level, charging } = getGlassBattery()
  const bat = level != null ? `  G2 ${level}%${charging ? '+' : ''}` : ''
  return `${time}  ${date}${bat}`
}

// summary 本文: 有効 group × 有効 segment を各 1 行に圧縮 (config 駆動 + status の値)。
function summaryBody(d: GlassData): string[] {
  const mc = activeCfg(d)
  const groups = groupsById(d.status)
  const lines: string[] = []
  if (mc) {
    for (const gid of mc.sourceOrder) {
      const scfg = mc.sources[gid]
      const g = groups.get(gid)
      if (!scfg?.enabled || !g) continue
      const segs = new Map(g.segments.map((s) => [s.id, s]))
      const parts: string[] = []
      for (const m of scfg.metrics) {
        const seg = segs.get(m.id)
        if (m.enabled && seg) parts.push(`${seg.label} ${seg.value}`)
      }
      if (parts.length) lines.push(`${g.label}  ${parts.join('  ')}`)
    }
  }
  if (lines.length === 0) lines.push('(no metric)')
  return lines
}

// 詳細本文: その group の全 segment を bar 表示 (DESIGN.md §5、status の順序)。
function detailBody(d: GlassData, groupId: string): string[] {
  const g = groupsById(d.status).get(groupId)
  if (!g) return summaryBody(d)
  const lines = [g.label]
  for (const seg of g.segments) {
    if (typeof seg.percent === 'number') {
      lines.push(
        `${pad(seg.label, 8)} ${bar(seg.percent)} ${seg.value}${seg.reset ? ` ${seg.reset}` : ''}`,
      )
    } else {
      lines.push(`${pad(seg.label, 8)} ${seg.value}`)
    }
  }
  return lines
}

// HUD(最上部) + 本文 + ヒント(最下端) を MAX_ROWS 内に組む。
export function renderGlass(view: GView, d: GlassData): string {
  const body = view === 'summary' ? summaryBody(d) : detailBody(d, view)
  const hintText = view === 'summary' ? 'swipe: detail  tap: back' : 'swipe / tap: back'
  const hint = d.config.glassHints ? hintText : null

  const head = [hudLine(), ...body]
  if (!hint) return head.join('\n')
  const blanks = MAX_ROWS - head.length - 1
  const out = blanks > 0 ? [...head, ...Array<string>(blanks).fill(''), hint] : [...head, hint]
  return out.join('\n')
}

// 有効 group に応じて詳細ビューを動的に構成する ([summary, ...有効groupId])。
export function buildViews(d: GlassData): GView[] {
  const out: GView[] = ['summary']
  const mc = activeCfg(d)
  const groups = groupsById(d.status)
  for (const gid of mc?.sourceOrder ?? []) {
    if (mc?.sources[gid]?.enabled && groups.has(gid)) out.push(gid)
  }
  return out
}
