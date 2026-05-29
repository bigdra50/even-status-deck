import { getTextWidth } from '@evenrealities/pretext'
import {
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  type Config,
  customLabelId,
  defaultShowGroupLabel,
  type GroupCfg,
  type GroupRef,
  isCustomLabelKey,
  isRightDivider,
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

// G2 ディスプレイ寸法と TextContainer padding (glass.ts の TextContainerProperty と一致させる)。
// 右クラスタの justify (右寄せ) は INNER_W の中で行う。
export const GLASS_WIDTH = 576
export const GLASS_HEIGHT = 288
export const GLASS_PADDING = 8
const INNER_W = GLASS_WIDTH - 2 * GLASS_PADDING // テキスト描画可能幅 (560px)
const SPACE_W = getTextWidth(' ') // proportional フォントの space 1 個の advance 幅 (px)

// progress bar: ━(filled) / ─(empty)。DESIGN.md §5 準拠。
export function bar(percent: number, width = 12): string {
  const p = Math.max(0, Math.min(100, percent))
  const filled = Math.round((p / 100) * width)
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

// segment 値を widthChars 枠に合わせる。短ければ pad (数値=右寄せ / 文字列=左寄せ) で枠確保、
// 超えれば末尾 … で省略 (合計 widthChars)。widthChars 未設定 (server 等) は無加工。
export function formatSegmentValue(value: string, widthChars?: number, isNumeric = false): string {
  if (!widthChars) return value
  if (value.length <= widthChars) {
    return isNumeric ? value.padStart(widthChars, ' ') : pad(value, widthChars)
  }
  const head = Math.max(1, widthChars - 1)
  return `${value.slice(0, head)}…`
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

// group が default-label (group 名の前置) を出すか。未設定は groupId 既定 (clock=false/他=true)。
function showsGroupLabel(gcfg: GroupCfg, groupId: string): boolean {
  return gcfg.showDefaultLabel ?? defaultShowGroupLabel(groupId)
}

// items を解決して 1 クラスタの文字列を連結する。各 segment は値 (segLabel value) を出し、group の
// default-label が ON なら group 名を前置する。隣接する同 group の run では先頭 1 回だけ
// (dedup)。custom テキストラベルは独立要素で run を切る。enabled/表示条件/status でフィルタ。
function renderKeys(items: string[], d: GlassData, visible?: VisibleMap): string {
  const parts: string[] = []
  let prevGroup: string | null = null // 直前に出力した segment の groupId (custom label / 行頭で null)
  for (const key of items) {
    if (isCustomLabelKey(key)) {
      const text = d.config.glassLayout?.customLabels[customLabelId(key)]?.text
      if (text) {
        parts.push(text) // ユーザー定義の自由テキストラベル
        prevGroup = null // run を切る (後続の同 group はラベル再表示)
      }
      continue
    }
    const [sourceId, groupId, segId] = key.split('|')
    if (!sourceId || !groupId || !segId) continue
    if (segId === LABEL_SEG) continue // 旧 @label 配置 chip は廃止 (migration で除去済)
    const gcfg = d.config.groups[sourceId]?.[groupId]
    if (!gcfg?.enabled) continue // group 無効
    const sc = gcfg.segments.find((s) => s.id === segId)
    if (!sc?.enabled) continue // segment 無効
    if (!isVisible(visible, key)) continue // 表示タイミング条件
    const seg = findGroup(d, { sourceId, groupId })?.segments.find((s) => s.id === segId)
    if (!seg) continue // status 欠落 (missing) → 描画時 skip (rows からは消さない)
    const v = formatSegmentValue(seg.value, seg.widthChars, seg.isNumeric ?? false)
    const body = seg.label ? `${seg.label} ${v}` : v
    // default-label: ON かつ run の先頭 (直前と group が変わった) なら group 名を前置
    if (showsGroupLabel(gcfg, groupId) && groupId !== prevGroup) {
      const gl = groupLabelText(d, sourceId, groupId)
      parts.push(gl ? `${gl} ${body}` : body)
    } else {
      parts.push(body)
    }
    prevGroup = groupId
  }
  return parts.length ? parts.join('  ') : ''
}

// 1 行を @right 区切りで左右クラスタの key 配列に分ける。@right が無ければ全て左。
// normalize で @right は行内 1 個に正規化済 (念のため右側からは除外する)。
export function splitRowClusters(row: string[]): { left: string[]; right: string[] } {
  const i = row.findIndex(isRightDivider)
  if (i < 0) return { left: row, right: [] }
  return { left: row.slice(0, i), right: row.slice(i + 1).filter((k) => !isRightDivider(k)) }
}

export type RowClusters = { left: string; right: string }

// 1 行の左右クラスタを描画文字列にする (companion プレビューが flex で左右配置に使う)。
function rowClusters(row: string[], d: GlassData, visible?: VisibleMap): RowClusters {
  const { left, right } = splitRowClusters(row)
  return { left: renderKeys(left, d, visible), right: renderKeys(right, d, visible) }
}

// custom layout 各行の左右クラスタ (描画文字列)。companion プレビューが flex space-between で
// 正確に左右表示するのに使う (実機の space 近似と違い px 量子化しない)。
export function layoutRowClusters(
  d: GlassData,
  visible: VisibleMap | undefined,
  budget: number,
): RowClusters[] {
  const rows = d.config.glassLayout?.rows ?? []
  const out: RowClusters[] = []
  for (let i = 0; i < budget; i++) out.push(rowClusters(rows[i] ?? [], d, visible))
  return out
}

// 左右クラスタを 1 行文字列に justify する。実機は単一 TextContainer (content) しか持たないため
// 中央を space で充填して右クラスタを右端へ寄せる近似 (誤差 ≒ SPACE_W/2)。pretext で px 計測。
// - 右が空: 左だけ (従来の左寄せ)。- 左が空: 行頭 space で右寄せ。- 両方: 中央 space は最低 1 個。
function justifyClusters({ left, right }: RowClusters): string {
  if (!right) return left
  const rightW = getTextWidth(right)
  if (!left) {
    const pad = Math.max(0, Math.round((INNER_W - rightW) / SPACE_W))
    return ' '.repeat(pad) + right
  }
  const gap = Math.round((INNER_W - getTextWidth(left) - rightW) / SPACE_W)
  return left + ' '.repeat(Math.max(1, gap)) + right
}

// custom layout (固定行) の絶対行レンダー。budget 行ぶん (空行は '' で保持) を返す。
// 行番号 = 絶対位置なので空行も保持する (上の空行が下へ押し下げる)。各行は @right 区切りで
// 左右クラスタに分け、右クラスタがあれば中央 space 充填で右端へ寄せる。
export function layoutLines(
  d: GlassData,
  visible: VisibleMap | undefined,
  budget: number,
): string[] {
  return layoutRowClusters(d, visible, budget).map(justifyClusters)
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
    const v = formatSegmentValue(seg.value, seg.widthChars, seg.isNumeric ?? false)
    if (typeof seg.percent === 'number') {
      const name = seg.label ? pad(seg.label, 8) : ''
      lines.push(`${name} ${bar(seg.percent)} ${v}${seg.reset ? ` ${seg.reset}` : ''}`.trim())
    } else {
      lines.push(seg.label ? `${pad(seg.label, 8)} ${v}` : v)
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
