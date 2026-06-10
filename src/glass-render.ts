import { getTextWidth } from '@evenrealities/pretext'
import {
  activeView,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  type Config,
  customLabelId,
  defaultShowGroupLabel,
  type GlassLayout,
  type GlassPage,
  type GridCellSpec,
  type GroupMeta,
  type GroupRef,
  isCustomLabelKey,
  isRightDivider,
  LABEL_SEG,
  type ProfileView,
  resolvePages,
  type ViewGroup,
} from './config'
import {
  computeGroupMergeUnits,
  effectiveGroupHeading,
  type GroupMergeUnit,
  normalizeHeading,
} from './display-identity'
import { type CompiledCell, cellRect, compileGrid, type GridCell } from './glass-layout'
import {
  cellRowCapacity,
  GLASS_PADDING,
  GLASS_WIDTH,
  IMAGE_CONTAINER_ID_BASE,
  MAX_ROWS,
} from './glass-types'
import { sanitizeGlyphs } from './glyphs'
import type { Group, StatusDoc } from './status-types'
import { isVisible, segKey, type VisibleMap } from './visibility'

// glass 描画の純粋ロジック (bridge 非依存)。複数ソース (builtin + server) を active profile の
// view.groupOrder で横断描画する。GlassData の statuses は sourceId -> 直近 StatusDoc。
// HUD (時刻/電池) は builtin local の group (clock / g2) として groupOrder に含まれる。
// 素材 (config.groups: GroupMeta) が segment の存在・順序・format を持ち、可視性 (enabled /
// segment ON-OFF / align / showDefaultLabel) は active profile の view (ViewGroup) を読む。
// 描画単位は merge unit (display-identity): 同 source 内で見出しが一致する group は summary 1 行 /
// detail 1 ページに統合する。unit 構成は config のみで決まる (offline で揺れない)。
// 描画時の仮想/実ページ。auto デッキ (autoSummary/autoDetail) は render-time に組み永続化しない。
// custom は view.pages のユーザー定義をそのまま描く。scroll はこの列を巡回する。
export type RuntimePage =
  | { kind: 'autoSummary' }
  | { kind: 'autoDetail'; unit: GroupMergeUnit }
  | { kind: 'custom'; page: GlassPage }
export type GlassData = {
  config: Config
  statuses: Record<string, StatusDoc | null>
}

// 定数は glass-types.ts へ分離 (config / glass-layout との循環回避)。既存 import 互換のため再エクスポート。
export { GLASS_HEIGHT, GLASS_PADDING, GLASS_WIDTH, MAX_ROWS } from './glass-types'

// 右クラスタの justify (右寄せ) は INNER_W の中で行う。
const INNER_W = GLASS_WIDTH - 2 * GLASS_PADDING // テキスト描画可能幅 (560px)
const SPACE_W = getTextWidth(' ') // proportional フォントの space 1 個の advance 幅 (px)

// progress bar: ━(filled) / ─(empty)。DESIGN.md §5 準拠。
export function bar(percent: number, width = 12): string {
  const p = Math.max(0, Math.min(100, percent))
  const filled = Math.round((p / 100) * width)
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

// East Asian Width: 全角 (CJK / かな / Hangul / 全角形 / 絵文字) を 2 桁、その他を 1 桁で数える。
// フォントは proportional なので厳密幅ではないが、文字数 (.length = UTF-16 code unit) より遥かに
// 視覚幅へ近く、全角での列ズレ / サロゲート分断を防ぐ。行全体の overflow 防止は justifyClusters の
// px 計測 (getTextWidth) が担う。これにより widthChars は「表示桁 (全角=2)」の意味になる。
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 / 康熙 / CJK 記号・句読点
    (cp >= 0x3041 && cp <= 0x33ff) || // ひらがな〜CJK 互換
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 統合漢字
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // ハングル音節
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 互換漢字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 互換形
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角記号
    (cp >= 0x1f000 && cp <= 0x1f0ff) || // 麻雀 / 牌 / トランプ
    (cp >= 0x1f300 && cp <= 0x1faff) || // 絵文字
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B 以降
  )
}

// 文字列の表示幅 (全角=2 / 半角=1)。code point 単位で走査しサロゲートペアを割らない。
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return w
}

// 表示幅 n まで右側を半角 space で埋める (左寄せ)。
function pad(s: string, n: number): string {
  const w = displayWidth(s)
  return w >= n ? s : s + ' '.repeat(n - w)
}

// 表示幅 n まで左側を半角 space で埋める (右寄せ・数値用)。
function padLeft(s: string, n: number): string {
  const w = displayWidth(s)
  return w >= n ? s : ' '.repeat(n - w) + s
}

// segment 値を widthChars 枠 (表示桁) に合わせる。短ければ pad (数値=右寄せ / 文字列=左寄せ)、
// 超えれば末尾 … で省略 (合計表示幅 ≤ widthChars)。切り詰めは code point 単位で全角を 2 桁と数え、
// サロゲートペア / 絵文字を割らない。widthChars 未設定 (server 等) は無加工。
export function formatSegmentValue(value: string, widthChars?: number, isNumeric = false): string {
  // 幅計算 (省略/pad) の前に sanitize する。後段で sanitize すると ✅→OK の幅変化が
  // 切り詰め枠を超え、グラスで折り返し → 2 ページ目へ溢れる回帰を起こすため (issue #11)。
  const v = sanitizeGlyphs(value)
  if (!widthChars) return v
  if (displayWidth(v) <= widthChars) {
    return isNumeric ? padLeft(v, widthChars) : pad(v, widthChars)
  }
  let w = 0
  let out = ''
  for (const ch of v) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (w + cw > widthChars - 1) break // … 1 桁分を残す
    out += ch
    w += cw
  }
  return `${out}…`
}

function findGroup(d: GlassData, ref: GroupRef): Group | undefined {
  return d.statuses[ref.sourceId]?.groups.find((g) => g.id === ref.groupId)
}

// 1 group の summary 用 segment parts ("label value")。enabled かつ表示条件を満たす segment を
// 素材順 (GroupMeta.segments) で集める。ON/OFF は view (ViewGroup.segments)。
// 幅計測 (clampSummaryLine) の前に sanitize する (後段 sanitize は ✅→OK の幅変化で枠を超える。issue #11)。
function groupSegmentParts(
  g: Group,
  meta: GroupMeta,
  vg: ViewGroup,
  ref: GroupRef,
  visible?: VisibleMap,
): string[] {
  const segs = new Map(g.segments.map((s) => [s.id, s]))
  const parts: string[] = []
  for (const sm of meta.segments) {
    const seg = segs.get(sm.id)
    if (!(vg.segments[sm.id] ?? true) || !seg) continue
    if (!isVisible(visible, segKey(ref.sourceId, ref.groupId, sm.id))) continue
    parts.push(sanitizeGlyphs(seg.label ? `${seg.label} ${seg.value}` : seg.value))
  }
  return parts
}

// unit の summary parts: enabled な live member の parts を groupOrder 順に連結。
// offline/disabled member は供出しないだけで unit 構成 (位置/align) には影響しない。
function unitParts(
  d: GlassData,
  view: ProfileView,
  unit: GroupMergeUnit,
  visible?: VisibleMap,
): string[] {
  const parts: string[] = []
  for (const ref of unit.members) {
    const vg = view.groups[ref.sourceId]?.[ref.groupId]
    const meta = d.config.groups[ref.sourceId]?.[ref.groupId]
    if (!vg?.enabled || !meta) continue
    const g = findGroup(d, ref)
    if (!g) continue
    parts.push(...groupSegmentParts(g, meta, vg, ref, visible))
  }
  return parts
}

// unit の表示見出し。merged は unit.heading (merge identity = 全 member 共通)。singleton は従来規則
// (displayName || live g.label) を維持し、builtin の見出し無し ('' = 前置なし) を変えない。
// 空文字 displayName は採用しない (groupLabelText と falsy 扱いを揃える)。sanitize 済みを返す。
function unitHeading(d: GlassData, unit: GroupMergeUnit): string {
  if (unit.members.length > 1) return sanitizeGlyphs(unit.heading)
  const ref = unit.rep
  const meta = d.config.groups[ref.sourceId]?.[ref.groupId]
  return sanitizeGlyphs(meta?.displayName || findGroup(d, ref)?.label || '')
}

// summary 行を物理 1 行に clamp する。segment 境界で px 幅 (getTextWidth) が安全幅に収まる分まで
// 詰め、残りは '… +N'。autoSummary の top/bottom gap 計算 (renderRuntimePage) は論理行数ベース
// なので、折り返しで物理行が増えると 10 行予算を破る — summary は必ず物理 1 行にして防ぐ
// (全データは autoDetail ページで見る)。安全幅は justifyClusters と同じく space 1 個分を残す。
function clampSummaryLine(heading: string, parts: string[]): string {
  const safe = INNER_W - SPACE_W
  const join = (ps: string[]) => (heading ? [heading, ...ps] : ps).join('  ')
  if (getTextWidth(join(parts)) <= safe) return join(parts)
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const line = `${join(parts.slice(0, keep))}  … +${parts.length - keep}`
    if (getTextWidth(line) <= safe) return line
  }
  // 見出し + 先頭 1 part 単独でも超える極端例: 文字単位の px 切り詰めで物理 1 行を絶対保証する。
  const tail = parts.length > 1 ? `  … +${parts.length - 1}` : ''
  return truncateToWidth(join(parts.slice(0, 1)), safe - getTextWidth(tail)) + tail
}

// 文字列を px 幅 maxPx 以下へ code point 単位で切り詰め、削ったら '…' を付ける (サロゲートを割らない)。
// clampSummaryLine の最終 fallback 専用 (劣化値が summary に来る病的ケースのみ走る)。
// 注: 最小出力は「先頭 1 code point + '…'」なので、その合計幅未満の maxPx では超過しうる
// (呼び出し元の maxPx は常に「安全幅 − '… +N' 幅」≒ 540px なので実際には到達しない)。
function truncateToWidth(s: string, maxPx: number): string {
  if (getTextWidth(s) <= maxPx) return s
  const cps = [...s]
  while (cps.length > 1 && getTextWidth(`${cps.join('')}…`) > maxPx) cps.pop()
  return `${cps.join('')}…`
}

// group ラベルテキスト (表示用)。手動 rename の displayName(素材) を最優先し、無ければ
// builtin=code-owned / server=status group.label or source label。live は呼び出し元が解決済みの
// status group を渡す (renderKeys が segment 解決で同じ group を引くため、二重検索を避ける)。
function groupLabelText(d: GlassData, sourceId: string, groupId: string, live?: Group): string {
  const override = d.config.groups[sourceId]?.[groupId]?.displayName
  if (override) return override
  if (sourceId === BUILTIN_SOURCE_ID) return BUILTIN_GROUP_LABELS[groupId] ?? groupId
  return live?.label || d.config.sources.find((s) => s.id === sourceId)?.label || groupId
}

// group が default-label (group 名の前置) を出すか。未設定は groupId 既定 (clock=false/他=true)。
function showsGroupLabel(vg: ViewGroup, groupId: string): boolean {
  return vg.showDefaultLabel ?? defaultShowGroupLabel(groupId)
}

// items を解決して 1 クラスタの文字列を連結する。各 segment は値 (segLabel value) を出し、group の
// default-label が ON なら group 名を前置する。隣接する「同見出し」(同 source + 正規化見出し一致 =
// merge unit と同じ規則) の run では先頭 1 回だけ (dedup)。見出しを実際に出すまで run を「ラベル済」
// にしない (label OFF の member が次 member の見出しを抑止しない)。custom テキストラベルは独立要素で
// run を切る。enabled/表示条件/status でフィルタ。
function renderKeys(
  items: string[],
  d: GlassData,
  customLabels: Record<string, { text: string }>,
  visible?: VisibleMap,
): string {
  const view = activeView(d.config)
  const parts: string[] = []
  let runKey: string | null = null // 現在の run の見出しキー (custom label / 行頭で null)
  let runLabeled = false // この run で見出しを出力済みか
  for (const key of items) {
    if (isCustomLabelKey(key)) {
      const text = customLabels[customLabelId(key)]?.text
      if (text) {
        parts.push(text) // ユーザー定義の自由テキストラベル
        runKey = null // run を切る (後続の同見出しはラベル再表示)
        runLabeled = false
      }
      continue
    }
    const [sourceId, groupId, segId] = key.split('|')
    if (!sourceId || !groupId || !segId) continue
    if (segId === LABEL_SEG) continue // 旧 @label 配置 chip は廃止 (migration で除去済)
    const vg = view.groups[sourceId]?.[groupId]
    if (!vg?.enabled) continue // group 無効
    const meta = d.config.groups[sourceId]?.[groupId]
    if (!meta?.segments.some((s) => s.id === segId)) continue // 素材に存在しない segment
    if (!(vg.segments[segId] ?? true)) continue // segment 無効
    if (!isVisible(visible, key)) continue // 表示タイミング条件
    const liveGroup = findGroup(d, { sourceId, groupId })
    const seg = liveGroup?.segments.find((s) => s.id === segId)
    if (!seg) continue // status 欠落 (missing) → 描画時 skip (rows からは消さない)
    const v = formatSegmentValue(seg.value, seg.widthChars, seg.isNumeric ?? false)
    const body = seg.label ? `${seg.label} ${v}` : v
    // run の識別は merge identity (effectiveGroupHeading)。表示フォールバック (groupLabelText の
    // source label / groupId) を混ぜると、空見出しの別 group 同士が誤って dedup される。
    // 空見出しは merge unit と同じく決して他 group と dedup しない (per-group キー)。
    const headingKey = normalizeHeading(effectiveGroupHeading(d.config, sourceId, groupId))
    const headKey = headingKey
      ? `h:${sourceId}\u0000${headingKey}`
      : `g:${sourceId}\u0000${groupId}`
    if (headKey !== runKey) {
      runKey = headKey
      runLabeled = false
    }
    // default-label: ON かつこの run でまだ見出しを出していなければ前置 (ラベル文言は表示用の
    // groupLabelText。解決は出すときだけ = label OFF の segment で余計な status 検索をしない)
    if (showsGroupLabel(vg, groupId) && !runLabeled) {
      const gl = groupLabelText(d, sourceId, groupId, liveGroup)
      if (gl) {
        parts.push(`${gl} ${body}`)
        runLabeled = true
      } else {
        parts.push(body)
      }
    } else {
      parts.push(body)
    }
  }
  // 値は formatSegmentValue で sanitize 済 (切り詰め前)。ラベル/custom テキストはここで sanitize する。
  // justify は本関数の出力(クラスタ文字列)を px 計測するので、出力段で sanitize すれば幅は整合する。
  return parts.length ? sanitizeGlyphs(parts.join('  ')) : ''
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
function rowClusters(
  row: string[],
  d: GlassData,
  customLabels: Record<string, { text: string }>,
  visible?: VisibleMap,
): RowClusters {
  const { left, right } = splitRowClusters(row)
  return {
    left: renderKeys(left, d, customLabels, visible),
    right: renderKeys(right, d, customLabels, visible),
  }
}

// 任意の行スロット列 (linear layout の rows / grid セル内の rows) を左右クラスタへ解決する。
// budget 行ぶん (空行は '' で保持) 返す。
export function rowSlotClusters(
  rows: string[][],
  customLabels: Record<string, { text: string }>,
  d: GlassData,
  visible: VisibleMap | undefined,
  budget: number,
): RowClusters[] {
  const out: RowClusters[] = []
  for (let i = 0; i < budget; i++) out.push(rowClusters(rows[i] ?? [], d, customLabels, visible))
  return out
}

// custom layout 各行の左右クラスタ (描画文字列)。companion プレビューが flex space-between で
// 正確に左右表示するのに使う (実機の space 近似と違い px 量子化しない)。
export function layoutRowClusters(
  lay: GlassLayout,
  d: GlassData,
  visible: VisibleMap | undefined,
  budget: number,
): RowClusters[] {
  return rowSlotClusters(lay.rows ?? [], lay.customLabels, d, visible, budget)
}

// 左右クラスタを 1 行文字列に justify する。実機は単一 TextContainer (content) しか持たないため
// 中央を space で充填して右クラスタを右端へ寄せる近似。pretext で px 計測。width = 描画可能幅
// (全面 layout は INNER_W、grid セルはセル内寸)。
// space 数は floor + 安全マージン (space 1 個) で決める。round 切り上げや pretext/実機 LVGL の
// per-glyph 丸め差で合計が width を数 px でも超えると、最後の単語が word wrap して行が増え、
// 行予算を超えた分が溢れるため (実機で確認)。floor なら合計 < width を保証する。
// - 右が空: 左だけ (従来の左寄せ)。- 左が空: 行頭 space で右寄せ。- 両方: 中央 space は最低 1 個。
function justifyClusters({ left, right }: RowClusters, width: number): string {
  if (!right) return left
  const rightW = getTextWidth(right)
  const safe = width - SPACE_W // 右端に space 1 個分の余白を残し、丸め/フォント差での超過を防ぐ
  if (!left) {
    const pad = Math.max(0, Math.floor((safe - rightW) / SPACE_W))
    return ' '.repeat(pad) + right
  }
  // 左+右が幅を超えるときは左を px 切り詰めて右クラスタを守る。後段の安全網 (fitLine) は
  // 末尾 = 右側から削るため、ここで放置すると @right 側が丸ごと欠落する (小さい grid セルで現実に起きる)。
  const avail = safe - rightW - SPACE_W // 中央 space 最低 1 個分を確保した左クラスタの上限幅
  const l = getTextWidth(left) <= avail ? left : avail > 0 ? truncateToWidth(left, avail) : ''
  if (!l || getTextWidth(l) > avail) {
    // 右クラスタだけで幅が尽きる極小セル: 右を優先し左は出さない。
    const pad = Math.max(0, Math.floor((safe - rightW) / SPACE_W))
    return ' '.repeat(pad) + right
  }
  const gap = Math.max(1, Math.floor((safe - getTextWidth(l) - rightW) / SPACE_W))
  return l + ' '.repeat(gap) + right
}

// custom layout (固定行) の絶対行レンダー。budget 行ぶん (空行は '' で保持) を返す。
// 行番号 = 絶対位置なので空行も保持する (上の空行が下へ押し下げる)。各行は @right 区切りで
// 左右クラスタに分け、右クラスタがあれば中央 space 充填で右端へ寄せる。
export function layoutLines(
  lay: GlassLayout,
  d: GlassData,
  visible: VisibleMap | undefined,
  budget: number,
): string[] {
  return layoutRowClusters(lay, d, visible, budget).map((rc) => justifyClusters(rc, INNER_W))
}

// ── grid ページ (Issue #17: cell→segment データ束縛) ──

// 1 セルの描画行 (justify 済み)。行数はセル内寸の行容量に clamp し、各行はセル内寸幅で
// 左右 justify する。custom label の本文は page.layout.customLabels を共有する。
export function gridCellLines(
  cell: GridCellSpec,
  customLabels: Record<string, { text: string }>,
  d: GlassData,
  visible?: VisibleMap,
): string[] {
  const { w } = cellRect(cell)
  const inset = 2 * ((cell.border ?? 0) + (cell.padding ?? 0))
  const budget = cellRowCapacity(cell)
  const count = Math.min(cell.rows.length, budget)
  const innerW = w - inset
  return rowSlotClusters(cell.rows, customLabels, d, visible, count).map((rc) =>
    justifyClusters(rc, innerW),
  )
}

// image cell のコンパイル結果 (幾何 + 束縛)。bytes の描画/送信は glass.ts / glass-sync が行う
// (画像実体は container 作成後に updateImageRawData で別送する SDK 仕様)。
export type CompiledImageCell = {
  xPosition: number
  yPosition: number
  width: number
  height: number
  containerID: number
  containerName: string
  image: GridImageSpec
}

// grid ページのコンパイル結果。texts は event 層込みの text コンテナ列、images は別レンジの
// containerID (IMAGE_CONTAINER_ID_BASE+) を持つ image コンテナ列。
export type CompiledGridPage = { texts: CompiledCell[]; images: CompiledImageCell[] }

// grid ページの各セル content を解決して compiler へ渡す (event 層は compileGrid が注入)。
// fitContent は既定 ON のまま (justify は幅を保証するが、px 丸め差の安全網として通す)。
// image cell は text と分離してコンパイルする (SDK 上限: text 8 / image 4 / 計 12)。
export function compileGridPage(
  page: GlassPage,
  d: GlassData,
  visible?: VisibleMap,
): CompiledGridPage {
  const labels = page.layout.customLabels
  const all = page.grid?.cells ?? []
  const cells = all
    .filter((c) => c.kind !== 'image')
    .map((c): GridCell => {
      const cell: GridCell = {
        id: c.id,
        col: c.col,
        row: c.row,
        colSpan: c.colSpan,
        rowSpan: c.rowSpan,
        content: gridCellLines(c, labels, d, visible).join('\n'),
      }
      if (c.border !== undefined) cell.border = c.border
      if (c.radius !== undefined) cell.radius = c.radius
      if (c.padding !== undefined) cell.padding = c.padding
      return cell
    })
  const images = all
    .filter((c) => c.kind === 'image' && c.image)
    .map((c, i): CompiledImageCell => {
      const { x, y, w, h } = cellRect(c)
      return {
        xPosition: x,
        yPosition: y,
        width: w,
        height: h,
        containerID: IMAGE_CONTAINER_ID_BASE + i,
        containerName: c.id,
        image: c.image as GridImageSpec,
      }
    })
  return { texts: compileGrid({ cells }), images }
}

// custom ページが grid 描画対象なら GlassPage を返す (mode が単一の分岐軸)。
export function gridPageOf(page: RuntimePage): GlassPage | null {
  return page.kind === 'custom' && page.page.mode === 'grid' && page.page.grid ? page.page : null
}

// grid ページが描画可能な内容を 1 つでも持つか (空ページ skip 判定)。image cell は常に描画内容
// (icon は静的、sparkline は履歴待ちでも枠は出る) とみなす。
function hasRenderableGrid(page: GlassPage, d: GlassData, visible?: VisibleMap): boolean {
  return (page.grid?.cells ?? []).some((c) =>
    c.kind === 'image'
      ? !!c.image
      : gridCellLines(c, page.layout.customLabels, d, visible).some((l) => l.trim() !== ''),
  )
}

// grid ページの平文化 (text セルを row,col 順に連結・空行除去・10 行 clamp)。
// overlay の下地/コンテキスト行に使う近似 (overlay 表示中のみ。image cell は出さない)。
export function gridPageText(page: GlassPage, d: GlassData, visible?: VisibleMap): string {
  const cells = [...(page.grid?.cells ?? [])]
    .filter((c) => c.kind !== 'image')
    .sort((a, b) => a.row - b.row || a.col - b.col)
  const lines = cells.flatMap((c) => gridCellLines(c, page.layout.customLabels, d, visible))
  return lines
    .filter((l) => l.trim() !== '')
    .slice(0, MAX_ROWS)
    .join('\n')
}

// unit=1行 の summary 描画 (glassLayout 未設定時)。align で top/bottom に振り分ける。
// companion プレビュー (auto) でも再利用する。align は代表 (groupOrder 先頭 member) に従う —
// 静的代表なので offline/disable で行位置が動かない (member 間で align が食い違っても代表を採用)。
export function summarySections(
  d: GlassData,
  visible?: VisibleMap,
): { top: string[]; bottom: string[] } {
  const view = activeView(d.config)
  const top: string[] = []
  const bottom: string[] = []
  for (const unit of computeGroupMergeUnits(d.config, view)) {
    const parts = unitParts(d, view, unit, visible)
    if (!parts.length) continue // 全 member 不可視 → 行ごと消える
    const line = clampSummaryLine(unitHeading(d, unit), parts)
    const vg = view.groups[unit.rep.sourceId]?.[unit.rep.groupId]
    if (vg?.align === 'bottom') bottom.push(line)
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

// 詳細本文: unit の enabled な live member 全ての (表示条件を満たす) segment を bar 表示
// (percent あれば)。見出しは unit で 1 回。segment の ON/OFF (vg.segments) は意図的に見ない
// (detail はその unit の全データを見る画面)。全 member が status 欠落なら summary へフォールバック。
function detailBody(d: GlassData, unit: GroupMergeUnit, visible?: VisibleMap): string[] {
  const view = activeView(d.config)
  const heading = unitHeading(d, unit)
  const lines: string[] = heading ? [heading] : []
  let live = false
  for (const ref of unit.members) {
    if (!view.groups[ref.sourceId]?.[ref.groupId]?.enabled) continue // disabled member は供出しない
    const g = findGroup(d, ref)
    if (!g) continue // offline member はスキップ (代表欠落でも summary へはフォールバックしない)
    live = true
    for (const seg of g.segments) {
      if (!isVisible(visible, segKey(ref.sourceId, ref.groupId, seg.id))) continue
      const v = formatSegmentValue(seg.value, seg.widthChars, seg.isNumeric ?? false) // 値は sanitize 済
      // ラベルは pad(幅計算) の前に sanitize する。reset も同様にグラスへ渡る前に通す。
      const label = seg.label ? sanitizeGlyphs(seg.label) : ''
      if (typeof seg.percent === 'number') {
        const name = label ? pad(label, 8) : ''
        const reset = seg.reset ? ` ${sanitizeGlyphs(seg.reset)}` : ''
        lines.push(`${name} ${bar(seg.percent)} ${v}${reset}`.trim())
      } else {
        lines.push(label ? `${pad(label, 8)} ${v}` : v)
      }
    }
  }
  if (!live) return summaryBody(d, visible)
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

// custom ページが描画可能な chip を 1 つでも持つか (空ページ skip 判定)。
function hasRenderableLayout(lay: GlassLayout, d: GlassData, visible?: VisibleMap): boolean {
  return layoutLines(lay, d, visible, MAX_ROWS).some((line) => line.trim() !== '')
}

// auto デッキの detail 対象 unit 列 (表示可能 segment が 1 つ以上ある unit。groupOrder 順)。
function renderableUnits(d: GlassData, visible?: VisibleMap): GroupMergeUnit[] {
  const view = activeView(d.config)
  return computeGroupMergeUnits(d.config, view).filter(
    (unit) => unitParts(d, view, unit, visible).length > 0,
  )
}

// 表示するランタイムページ列。pages (explicit デッキ) があればそれを、無ければ auto デッキ
// (summary + 描画可能 group の detail) を生成する。explicit では auto detail を混在させない (確定)。
// 空ページ (条件で全 chip 消滅) は巡回からスキップ。全ページ空なら custom 先頭 1 枚を fallback。
export function buildRuntimePages(d: GlassData, visible?: VisibleMap): RuntimePage[] {
  const view = activeView(d.config)
  const pages = resolvePages(view)
  if (pages.length) {
    const renderable = (p: GlassPage): boolean =>
      p.mode === 'grid' && p.grid
        ? hasRenderableGrid(p, d, visible)
        : hasRenderableLayout(p.layout, d, visible)
    const live = pages.filter(renderable)
    if (live.length) return live.map((page) => ({ kind: 'custom', page }))
    return [{ kind: 'custom', page: pages[0] as GlassPage }] // 全空 → 先頭 1 枚 (空表示)
  }
  return [
    { kind: 'autoSummary' },
    // unit snapshot をページに保持 (描画時に再解決せず、build 時の構成とズレない)。
    ...renderableUnits(d, visible).map((unit): RuntimePage => ({ kind: 'autoDetail', unit })),
  ]
}

// 1 ランタイムページの本文を budget 行で描く (autoSummary/autoDetail/custom 分岐)。
// budget はインジケータ有無で 9 (表示) or 10 (非表示)。
export function renderRuntimePage(
  page: RuntimePage,
  d: GlassData,
  budget: number,
  visible?: VisibleMap,
): string {
  if (page.kind === 'autoDetail') {
    // merged unit は member 数ぶん行が増えうるが、超過は clampRows の '+N more' に畳む (意図的)。
    return frame(clampRows(detailBody(d, page.unit, visible), budget), null)
  }
  if (page.kind === 'custom') {
    // grid ページの文字列表現は平文化 (通常描画は glass.ts がセル別コンテナで行う。
    // ここを通るのは overlay 下地などテキスト 1 枚が要る経路のみ)。
    const grid = gridPageOf(page)
    if (grid) return gridPageText(grid, d, visible)
    return layoutLines(page.page.layout, d, visible, budget).join('\n')
  }
  // autoSummary: align で top/bottom に振り分け、予算いっぱいに展開 (renderGlass の summary 分岐と同義)。
  const { top, bottom } = summarySections(d, visible)
  if (top.length + bottom.length === 0) return frame(['(no metric)'], null)
  if (bottom.length === 0) return frame(clampRows(top, budget), null)
  if (top.length + bottom.length > budget)
    return frame(clampRows([...top, ...bottom], budget), null)
  const gap = budget - top.length - bottom.length
  return frame([...top, ...Array<string>(gap).fill(''), ...bottom], null)
}

// デッキの現在ページ (安全 idx で巡回)。glass.ts が描画分岐 (single/grid) に使う。
export function currentPage(pages: RuntimePage[], idx: number): RuntimePage {
  const total = pages.length
  const safeIdx = total > 0 ? ((idx % total) + total) % total : 0
  return pages[safeIdx] ?? { kind: 'autoSummary' }
}

// デッキの現在ページを文字列で描く。全ページ本文 10 行。
// ページ位置インジケータは出さない (実機でドットが大きすぎるためユーザー判断で撤去)。
export function renderDeckPage(
  pages: RuntimePage[],
  idx: number,
  d: GlassData,
  visible?: VisibleMap,
): string {
  return renderRuntimePage(currentPage(pages, idx), d, MAX_ROWS, visible)
}
