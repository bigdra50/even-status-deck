import type { Config, GroupCfg, GroupRef } from './config'
import type { Group, StatusDoc } from './status-types'

// glass 描画の純粋ロジック (bridge 非依存)。複数ソース (builtin + server) を groupOrder で
// 横断描画する。GlassData の statuses は sourceId -> 直近 StatusDoc。
// HUD (時刻/電池) は builtin local の group "hud" として groupOrder に含まれる。
export type GView = 'summary' | GroupRef
export type GlassData = {
  config: Config
  statuses: Record<string, StatusDoc | null>
}

// 288px / line-height 27px ≒ 10 行。
const MAX_ROWS = 10

// progress bar: ━(filled) / ─(empty)。DESIGN.md §5 準拠。
export function bar(percent: number, width = 12): string {
  const p = Math.max(0, Math.min(100, percent))
  const filled = Math.round((p / 100) * width)
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function findGroup(d: GlassData, ref: GroupRef): Group | undefined {
  return d.statuses[ref.sourceId]?.groups.find((g) => g.id === ref.groupId)
}

// 1 group の summary 行: 有効 segment を "label value" (空ラベルは値のみ) で連結。
function groupLine(g: Group, gcfg: GroupCfg): string | null {
  const segs = new Map(g.segments.map((s) => [s.id, s]))
  const parts: string[] = []
  for (const sc of gcfg.segments) {
    const seg = segs.get(sc.id)
    if (sc.enabled && seg) parts.push(seg.label ? `${seg.label} ${seg.value}` : seg.value)
  }
  if (!parts.length) return null
  return g.label ? `${g.label}  ${parts.join('  ')}` : parts.join('  ')
}

// summary 本文: groupOrder を横断し、有効 group の行を並べる (config 駆動 + status の値)。
// companion プレビューでも再利用する。
export function summaryBody(d: GlassData): string[] {
  const lines: string[] = []
  for (const ref of d.config.groupOrder) {
    const gcfg = d.config.groups[ref.sourceId]?.[ref.groupId]
    if (!gcfg?.enabled) continue
    const g = findGroup(d, ref)
    if (!g) continue
    const line = groupLine(g, gcfg)
    if (line) lines.push(line)
  }
  if (lines.length === 0) lines.push('(no metric)')
  return lines
}

// 詳細本文: その group の全 segment を bar 表示 (percent あれば)。
function detailBody(d: GlassData, ref: GroupRef): string[] {
  const g = findGroup(d, ref)
  if (!g) return summaryBody(d)
  const lines: string[] = g.label ? [g.label] : []
  for (const seg of g.segments) {
    if (typeof seg.percent === 'number') {
      const name = seg.label ? pad(seg.label, 8) : ''
      lines.push(
        `${name} ${bar(seg.percent)} ${seg.value}${seg.reset ? ` ${seg.reset}` : ''}`.trim(),
      )
    } else {
      lines.push(seg.label ? `${pad(seg.label, 8)} ${seg.value}` : seg.value)
    }
  }
  return lines
}

// HUD は builtin group として本文に含まれるため、本文 + ヒント を MAX_ROWS に収める。
// 超過分は "+N more" に畳む (行予算 hard cap)。
export function renderGlass(view: GView, d: GlassData): string {
  const body = view === 'summary' ? summaryBody(d) : detailBody(d, view)
  const hintText = view === 'summary' ? 'swipe: detail  tap: back' : 'swipe / tap: back'
  const hint = d.config.glassHints ? hintText : null

  const budget = MAX_ROWS - (hint ? 1 : 0)
  const shown =
    body.length > budget
      ? [...body.slice(0, budget - 1), `… +${body.length - (budget - 1)} more`]
      : body

  if (!hint) return shown.join('\n')
  const blanks = MAX_ROWS - shown.length - 1
  const out = blanks > 0 ? [...shown, ...Array<string>(blanks).fill(''), hint] : [...shown, hint]
  return out.join('\n')
}

// 表示するビュー: summary + 有効 group (groupOrder 順)。
export function buildViews(d: GlassData): GView[] {
  const out: GView[] = ['summary']
  for (const ref of d.config.groupOrder) {
    const gcfg = d.config.groups[ref.sourceId]?.[ref.groupId]
    if (gcfg?.enabled && findGroup(d, ref)) out.push(ref)
  }
  return out
}
