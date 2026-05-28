import {
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  type Config,
  type GroupCfg,
  type GroupRef,
  LABEL_SEG,
} from './config'
import type { Group, StatusDoc } from './status-types'
import { isVisible, segKey, type VisibleMap } from './visibility'

// glass 描画の純粋ロジック (bridge 非依存)。複数ソース (builtin + server) を groupOrder で
// 横断描画する。GlassData の statuses は sourceId -> 直近 StatusDoc。
// HUD (時刻/電池) は builtin local の group (clock / g2) として groupOrder に含まれる。
export type GView = 'summary' | GroupRef
export type GlassData = {
  config: Config
  statuses: Record<string, StatusDoc | null>
}

// 288px / line-height 27px ≒ 10 行。glass の表示可能行数 (companion の行数上限にも使う)。
export const MAX_ROWS = 10

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

// 1 group の summary 行: enabled かつ表示条件を満たす segment を "label value" で連結。
// segment 単位の表示タイミング条件 (visible map) を適用する。全部隠れたら null (行ごと消える)。
function groupLine(g: Group, gcfg: GroupCfg, ref: GroupRef, visible?: VisibleMap): string | null {
  const segs = new Map(g.segments.map((s) => [s.id, s]))
  const parts: string[] = []
  for (const sc of gcfg.segments) {
    const seg = segs.get(sc.id)
    if (!sc.enabled || !seg) continue
    if (!isVisible(visible, segKey(ref.sourceId, ref.groupId, sc.id))) continue
    parts.push(seg.label ? `${seg.label} ${seg.value}` : seg.value)
  }
  if (!parts.length) return null
  return g.label ? `${g.label}  ${parts.join('  ')}` : parts.join('  ')
}

// group ラベルテキスト (builtin は code-owned、server は status group.label or source label)。
function groupLabelText(d: GlassData, sourceId: string, groupId: string): string {
  if (sourceId === BUILTIN_SOURCE_ID) return BUILTIN_GROUP_LABELS[groupId] ?? groupId
  return (
    findGroup(d, { sourceId, groupId })?.label ||
    d.config.sources.find((s) => s.id === sourceId)?.label ||
    groupId
  )
}

// items を解決して行文字列を連結する。glass に出るのは置いた要素だけ (自動接頭辞は無い)。
// LABEL_SEG の要素は group ラベルテキスト、それ以外は segment 値 (enabled/表示条件/status でフィルタ)。
function rowText(items: string[], d: GlassData, visible?: VisibleMap): string {
  const parts: string[] = []
  for (const key of items) {
    const [sourceId, groupId, segId] = key.split('|')
    if (!sourceId || !groupId || !segId) continue
    if (segId === LABEL_SEG) {
      parts.push(groupLabelText(d, sourceId, groupId)) // 配置式ラベル
      continue
    }
    const gcfg = d.config.groups[sourceId]?.[groupId]
    if (!gcfg?.enabled) continue // group 無効
    const sc = gcfg.segments.find((s) => s.id === segId)
    if (!sc?.enabled) continue // segment 無効
    if (!isVisible(visible, key)) continue // 表示タイミング条件
    const seg = findGroup(d, { sourceId, groupId })?.segments.find((s) => s.id === segId)
    if (!seg) continue // status 欠落 (missing) → 描画時 skip (rows からは消さない)
    parts.push(seg.label ? `${seg.label} ${seg.value}` : seg.value)
  }
  return parts.length ? parts.join('  ') : ''
}

// custom layout (固定行) の絶対行レンダー。budget 行ぶん (空行は '' で保持) を返す。
// 行番号 = 絶対位置なので空行も保持する (上の空行が下へ押し下げる)。
export function layoutLines(
  d: GlassData,
  visible: VisibleMap | undefined,
  budget: number,
): string[] {
  const rows = d.config.glassLayout?.rows ?? []
  const out: string[] = []
  for (let i = 0; i < budget; i++) out.push(rowText(rows[i] ?? [], d, visible))
  return out
}

// 従来の group=1行 描画 (glassLayout 未設定時)。align で top/bottom に振り分ける。
// companion プレビュー (auto) でも再利用する。
export function summarySections(
  d: GlassData,
  visible?: VisibleMap,
): { top: string[]; bottom: string[] } {
  const top: string[] = []
  const bottom: string[] = []
  for (const ref of d.config.groupOrder) {
    const gcfg = d.config.groups[ref.sourceId]?.[ref.groupId]
    if (!gcfg?.enabled) continue
    const g = findGroup(d, ref)
    if (!g) continue
    const line = groupLine(g, gcfg, ref, visible)
    if (!line) continue
    if (gcfg.align === 'bottom') bottom.push(line)
    else top.push(line)
  }
  return { top, bottom }
}

// summary 本文 (align を畳んだ平坦リスト)。detail フォールバック等で使う。
export function summaryBody(d: GlassData, visible?: VisibleMap): string[] {
  const { top, bottom } = summarySections(d, visible)
  const all = [...top, ...bottom]
  return all.length ? all : ['(no metric)']
}

// 詳細本文: その group の (表示条件を満たす) segment を bar 表示 (percent あれば)。
function detailBody(d: GlassData, ref: GroupRef, visible?: VisibleMap): string[] {
  const g = findGroup(d, ref)
  if (!g) return summaryBody(d, visible)
  const lines: string[] = g.label ? [g.label] : []
  for (const seg of g.segments) {
    if (!isVisible(visible, segKey(ref.sourceId, ref.groupId, seg.id))) continue
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

// HUD は builtin group (clock / g2) として本文に含まれる。glass には操作ヒントを出さない
// (10 行は貴重なので操作説明は companion 側に常設)。本文を MAX_ROWS に収める。
// custom は固定行を絶対描画。auto (未カスタマイズ) は align で top/bottom に寄せる。
export function renderGlass(view: GView, d: GlassData, visible?: VisibleMap): string {
  const budget = MAX_ROWS

  if (view !== 'summary') return frame(clampRows(detailBody(d, view, visible), budget), null)

  // custom layout: 固定行を絶対位置で描画 (空行も保持)。
  if (d.config.glassLayout) return layoutLines(d, visible, budget).join('\n')

  const { top, bottom } = summarySections(d, visible)
  if (top.length + bottom.length === 0) return frame(['(no metric)'], null)
  if (bottom.length === 0) return frame(clampRows(top, budget), null)
  if (top.length + bottom.length > budget) {
    return frame(clampRows([...top, ...bottom], budget), null)
  }
  // 予算いっぱいに展開: top を上、bottom を下、間を空行で埋める。
  const gap = budget - top.length - bottom.length
  return frame([...top, ...Array<string>(gap).fill(''), ...bottom], null)
}

// 表示するビュー: summary + 表示可能な segment が 1 つ以上ある有効 group (groupOrder 順)。
// 全 segment が条件で隠れた group は detail も出さない (groupLine が null)。
export function buildViews(d: GlassData, visible?: VisibleMap): GView[] {
  const out: GView[] = ['summary']
  for (const ref of d.config.groupOrder) {
    const gcfg = d.config.groups[ref.sourceId]?.[ref.groupId]
    if (!gcfg?.enabled) continue
    const g = findGroup(d, ref)
    if (g && groupLine(g, gcfg, ref, visible)) out.push(ref)
  }
  return out
}
