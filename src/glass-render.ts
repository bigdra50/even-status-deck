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

// summary 本文を align ごとに分割する。groupOrder を横断し、各 group の行を
// align ('top' 既定 / 'bottom') に応じて top / bottom セクションへ振り分ける。
// 各セクション内の順序は groupOrder のまま。companion プレビューでも再利用する。
export function summarySections(d: GlassData): { top: string[]; bottom: string[] } {
  const top: string[] = []
  const bottom: string[] = []
  for (const ref of d.config.groupOrder) {
    const gcfg = d.config.groups[ref.sourceId]?.[ref.groupId]
    if (!gcfg?.enabled) continue
    const g = findGroup(d, ref)
    if (!g) continue
    const line = groupLine(g, gcfg)
    if (!line) continue
    if (gcfg.align === 'bottom') bottom.push(line)
    else top.push(line)
  }
  return { top, bottom }
}

// summary 本文 (align を畳んだ平坦リスト)。detail フォールバック等で使う。
export function summaryBody(d: GlassData): string[] {
  const { top, bottom } = summarySections(d)
  const all = [...top, ...bottom]
  return all.length ? all : ['(no metric)']
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

// 行予算を超えたら先頭から budget-1 行 + "+N more" に畳む (hard cap)。
function clampRows(body: string[], budget: number): string[] {
  if (body.length <= budget) return body
  return [...body.slice(0, budget - 1), `… +${body.length - (budget - 1)} more`]
}

// body を上詰めし、hint を最下段に固定する (間は空行)。従来の詰め方。
function frame(body: string[], hint: string | null): string {
  if (!hint) return body.join('\n')
  const blanks = MAX_ROWS - body.length - 1
  const rows = blanks > 0 ? [...body, ...Array<string>(blanks).fill(''), hint] : [...body, hint]
  return rows.join('\n')
}

// HUD は builtin group として本文に含まれるため、本文 + ヒント を MAX_ROWS に収める。
// summary は align で top/bottom セクションに分け、間を空行で埋めて上下に寄せる。
// detail は単一 group なので従来通り上詰め。超過時は "+N more" に畳む (行予算 hard cap)。
export function renderGlass(view: GView, d: GlassData): string {
  const hint = d.config.glassHints
    ? view === 'summary'
      ? 'swipe: detail  tap: back'
      : 'swipe / tap: back'
    : null
  const budget = MAX_ROWS - (hint ? 1 : 0)

  if (view !== 'summary') return frame(clampRows(detailBody(d, view), budget), hint)

  const { top, bottom } = summarySections(d)
  if (top.length + bottom.length === 0) return frame(['(no metric)'], hint)

  // 下寄せ無し → 従来の上詰め (frame が hint を下段へ押す)。
  if (bottom.length === 0) return frame(clampRows(top, budget), hint)

  // 上下合計が予算超過 → anchoring を諦め上詰め + "+N more"。
  if (top.length + bottom.length > budget) {
    return frame(clampRows([...top, ...bottom], budget), hint)
  }

  // 予算いっぱいに展開: top を上、bottom を下、間を空行で埋める (body.length === budget)。
  const gap = budget - top.length - bottom.length
  return frame([...top, ...Array<string>(gap).fill(''), ...bottom], hint)
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
