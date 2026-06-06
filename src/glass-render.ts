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
  type GroupMeta,
  type GroupRef,
  isCustomLabelKey,
  isRightDivider,
  LABEL_SEG,
  type ProfileView,
  resolvePages,
  type ViewGroup,
} from './config'
import { computeGroupMergeUnits, type GroupMergeUnit, normalizeHeading } from './display-identity'
import { MAX_ROWS } from './glass-types'
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

// MAX_ROWS は glass-types.ts へ分離 (config との循環回避)。既存 import 互換のため再エクスポートする。
export { MAX_ROWS } from './glass-types'

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
  // 見出し + 先頭 1 part でも超える極端例。'… +N' は付けたまま折り返しに任せる (情報を黙って捨てない)。
  if (parts.length === 1) return join(parts)
  return `${join(parts.slice(0, 1))}  … +${parts.length - 1}`
}

// group ラベルテキスト。衝突解決/手動の displayName(素材) を最優先し、無ければ
// builtin=code-owned / server=status group.label or source label。
function groupLabelText(d: GlassData, sourceId: string, groupId: string): string {
  const override = d.config.groups[sourceId]?.[groupId]?.displayName
  if (override) return override
  if (sourceId === BUILTIN_SOURCE_ID) return BUILTIN_GROUP_LABELS[groupId] ?? groupId
  return (
    findGroup(d, { sourceId, groupId })?.label ||
    d.config.sources.find((s) => s.id === sourceId)?.label ||
    groupId
  )
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
    const seg = findGroup(d, { sourceId, groupId })?.segments.find((s) => s.id === segId)
    if (!seg) continue // status 欠落 (missing) → 描画時 skip (rows からは消さない)
    const v = formatSegmentValue(seg.value, seg.widthChars, seg.isNumeric ?? false)
    const body = seg.label ? `${seg.label} ${v}` : v
    const gl = groupLabelText(d, sourceId, groupId)
    const headKey = `${sourceId} ${normalizeHeading(gl)}` // 区切りは sourceId に現れない NUL
    if (headKey !== runKey) {
      runKey = headKey
      runLabeled = false
    }
    // default-label: ON かつこの run でまだ見出しを出していなければ前置
    if (showsGroupLabel(vg, groupId) && !runLabeled && gl) {
      parts.push(`${gl} ${body}`)
      runLabeled = true
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

// custom layout 各行の左右クラスタ (描画文字列)。companion プレビューが flex space-between で
// 正確に左右表示するのに使う (実機の space 近似と違い px 量子化しない)。
export function layoutRowClusters(
  lay: GlassLayout,
  d: GlassData,
  visible: VisibleMap | undefined,
  budget: number,
): RowClusters[] {
  const rows = lay.rows ?? []
  const out: RowClusters[] = []
  for (let i = 0; i < budget; i++)
    out.push(rowClusters(rows[i] ?? [], d, lay.customLabels, visible))
  return out
}

// 左右クラスタを 1 行文字列に justify する。実機は単一 TextContainer (content) しか持たないため
// 中央を space で充填して右クラスタを右端へ寄せる近似。pretext で px 計測。
// space 数は floor + 安全マージン (space 1 個) で決める。round 切り上げや pretext/実機 LVGL の
// per-glyph 丸め差で合計が INNER_W を数 px でも超えると、最後の単語が word wrap して行が増え、
// 10 行を超えた分が 2 ページ目に溢れるため (実機で確認)。floor なら合計 < INNER_W を保証する。
// - 右が空: 左だけ (従来の左寄せ)。- 左が空: 行頭 space で右寄せ。- 両方: 中央 space は最低 1 個。
function justifyClusters({ left, right }: RowClusters): string {
  if (!right) return left
  const rightW = getTextWidth(right)
  const safe = INNER_W - SPACE_W // 右端に space 1 個分の余白を残し、丸め/フォント差での超過を防ぐ
  if (!left) {
    const pad = Math.max(0, Math.floor((safe - rightW) / SPACE_W))
    return ' '.repeat(pad) + right
  }
  const gap = Math.max(1, Math.floor((safe - getTextWidth(left) - rightW) / SPACE_W))
  return left + ' '.repeat(gap) + right
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
  return layoutRowClusters(lay, d, visible, budget).map(justifyClusters)
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
    const live = pages.filter((p) => hasRenderableLayout(p.layout, d, visible))
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

// デッキの現在ページを描く (glass.ts の単一描画エントリ)。全ページ本文 10 行。
// ページ位置インジケータは出さない (実機でドットが大きすぎるためユーザー判断で撤去)。
export function renderDeckPage(
  pages: RuntimePage[],
  idx: number,
  d: GlassData,
  visible?: VisibleMap,
): string {
  const total = pages.length
  const safeIdx = total > 0 ? ((idx % total) + total) % total : 0
  const page = pages[safeIdx] ?? { kind: 'autoSummary' }
  return renderRuntimePage(page, d, MAX_ROWS, visible)
}
