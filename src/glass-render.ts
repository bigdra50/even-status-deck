import { getTextWidth } from '@evenrealities/pretext'
import {
  activeView,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  type Config,
  customLabelId,
  defaultShowGroupLabel,
  type GroupMeta,
  type GroupRef,
  isCustomLabelKey,
  isRightDivider,
  LABEL_SEG,
  type ViewGroup,
} from './config'
import type { Group, StatusDoc } from './status-types'
import { isVisible, segKey, type VisibleMap } from './visibility'

// glass 描画の純粋ロジック (bridge 非依存)。複数ソース (builtin + server) を active profile の
// view.groupOrder で横断描画する。GlassData の statuses は sourceId -> 直近 StatusDoc。
// HUD (時刻/電池) は builtin local の group (clock / g2) として groupOrder に含まれる。
// 素材 (config.groups: GroupMeta) が segment の存在・順序・format を持ち、可視性 (enabled /
// segment ON-OFF / align / showDefaultLabel) は active profile の view (ViewGroup) を読む。
export type ExpView = { exp: string } // 実験ページ (page2+, 実機検証用)
export type GView = 'summary' | GroupRef | ExpView
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
  if (!widthChars) return value
  if (displayWidth(value) <= widthChars) {
    return isNumeric ? padLeft(value, widthChars) : pad(value, widthChars)
  }
  let w = 0
  let out = ''
  for (const ch of value) {
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

// 1 group の summary 行: enabled かつ表示条件を満たす segment を "label value" で連結。
// 順序は素材 (GroupMeta.segments)、ON/OFF は view (ViewGroup.segments)。
// segment 単位の表示タイミング条件 (visible map) を適用する。全部隠れたら null (行ごと消える)。
function groupLine(
  g: Group,
  meta: GroupMeta,
  vg: ViewGroup,
  ref: GroupRef,
  visible?: VisibleMap,
): string | null {
  const segs = new Map(g.segments.map((s) => [s.id, s]))
  const parts: string[] = []
  for (const sm of meta.segments) {
    const seg = segs.get(sm.id)
    if (!(vg.segments[sm.id] ?? true) || !seg) continue
    if (!isVisible(visible, segKey(ref.sourceId, ref.groupId, sm.id))) continue
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
function showsGroupLabel(vg: ViewGroup, groupId: string): boolean {
  return vg.showDefaultLabel ?? defaultShowGroupLabel(groupId)
}

// items を解決して 1 クラスタの文字列を連結する。各 segment は値 (segLabel value) を出し、group の
// default-label が ON なら group 名を前置する。隣接する同 group の run では先頭 1 回だけ
// (dedup)。custom テキストラベルは独立要素で run を切る。enabled/表示条件/status でフィルタ。
function renderKeys(items: string[], d: GlassData, visible?: VisibleMap): string {
  const view = activeView(d.config)
  const parts: string[] = []
  let prevGroup: string | null = null // 直前に出力した segment の groupId (custom label / 行頭で null)
  for (const key of items) {
    if (isCustomLabelKey(key)) {
      const text = view.glassLayout?.customLabels[customLabelId(key)]?.text
      if (text) {
        parts.push(text) // ユーザー定義の自由テキストラベル
        prevGroup = null // run を切る (後続の同 group はラベル再表示)
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
    // default-label: ON かつ run の先頭 (直前と group が変わった) なら group 名を前置
    if (showsGroupLabel(vg, groupId) && groupId !== prevGroup) {
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
  const rows = activeView(d.config).glassLayout?.rows ?? []
  const out: RowClusters[] = []
  for (let i = 0; i < budget; i++) out.push(rowClusters(rows[i] ?? [], d, visible))
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
  const view = activeView(d.config)
  const top: string[] = []
  const bottom: string[] = []
  for (const ref of view.groupOrder) {
    const vg = view.groups[ref.sourceId]?.[ref.groupId]
    const meta = d.config.groups[ref.sourceId]?.[ref.groupId]
    if (!vg?.enabled || !meta) continue
    const g = findGroup(d, ref)
    if (!g) continue
    const line = groupLine(g, meta, vg, ref, visible)
    if (!line) continue
    if (vg.align === 'bottom') bottom.push(line)
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

  if (typeof view === 'object' && 'exp' in view) return renderExperiment(view.exp)
  if (view !== 'summary') return frame(clampRows(detailBody(d, view, visible), budget), null)

  // custom layout: 固定行を絶対位置で描画 (空行も保持)。
  if (activeView(d.config).glassLayout) return layoutLines(d, visible, budget).join('\n')

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

// --- 実験ページ (page2+) -------------------------------------------------------------
// 実機検証用の差し替え可能なページ群。検証内容に応じて中身を変える。page1 (summary) には影響しない。
// TODO(release): 公開前に EXPERIMENT_PAGES を空にする (または dev gate)。
type ExperimentPage = { id: string; render: () => string }

// 全角 / grapheme 幅の実機検証ページ。formatSegmentValue / pad の表示幅 (EAW) 修正を視認する。
// |...| の右端が ruler 行と縦に揃えば pad が効いている。CJK / 絵文字が描画できるかも確認できる。
function renderCjkWidthTest(): string {
  const W = 10
  return [
    'CJK / 全角 幅テスト',
    `ruler |${'.'.repeat(W)}|`,
    `ja    |${pad('日本語', W)}|`,
    `en    |${pad('abc', W)}|`,
    `num全 |${padLeft('１２３', W)}|`,
    `切詰  |${formatSegmentValue('あいうえおかきくけこさ', W)}|`,
    '絵文字 ☀ ☁ ☂ 😀 🎉 🔥',
    '混在  全角abc 半角 123円',
    `bar   ${bar(50)} 50%`,
    '行高  アガサ Agatha gjpq',
  ]
    .slice(0, MAX_ROWS)
    .join('\n')
}

const EXPERIMENT_PAGES: ExperimentPage[] = [{ id: 'cjk-width', render: renderCjkWidthTest }]

function renderExperiment(id: string): string {
  return EXPERIMENT_PAGES.find((p) => p.id === id)?.render() ?? '(experiment not found)'
}

// 表示するビュー。page1 = summary (従来どおり: リグレッション防止のため不変)。
// page2 以降 = 実験ページ (実機検証用)。旧 group detail ページは仕様再考のため休止 —
// detailBody / GroupRef 描画パスはコードに残し、ここで列挙しないだけ (復活は容易)。
export function buildViews(_d: GlassData, _visible?: VisibleMap): GView[] {
  return ['summary', ...EXPERIMENT_PAGES.map((p): ExpView => ({ exp: p.id }))]
}
