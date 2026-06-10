// グリッドレイアウト compiler (Issue #17「グリッドレイアウト設計」)。
// layout 定義 (セルの grid 座標) → SDK の TextContainerProperty 互換オブジェクト配列へ
// 決定的に変換する。text セルのみ・固定 12×10。各セルを px で座標配置するので、
// 列は座標で厳密に揃う (線形 status line の space パディングと違い proportional フォントでも揃う)。
import { getTextWidth } from '@evenrealities/pretext'
import {
  GLASS_HEIGHT,
  GLASS_PADDING,
  GLASS_WIDTH,
  GRID_COLS,
  GRID_ROWS,
  LINE_H,
} from './glass-types'

// 既存 import 互換のため再エクスポート (定義は glass-types.ts の leaf へ移動)。
export { GRID_COLS, GRID_ROWS, LINE_H } from './glass-types'

const COL_W = GLASS_WIDTH / GRID_COLS // 48
const ROW_H = GLASS_HEIGHT / GRID_ROWS // 28.8

export type GridCell = {
  id: string
  col: number
  row: number
  colSpan: number
  rowSpan: number
  content: string
  border?: number // borderWidth 0-5 (既定 0)
  radius?: number // borderRadius 0-10 (既定 0・角丸)
  padding?: number // paddingLength (既定 0)
}
export type GridLayout = { cols?: number; rows?: number; cells: GridCell[] }

// new TextContainerProperty(...) に渡せる plain object。
// borderRadius は radius 指定セルのみ持つ (未指定は toJson に出さない = PB default 0 と同義。
// 旧 status-line 単一コンテナと wire-identical にするため optional)。
export type CompiledCell = {
  xPosition: number
  yPosition: number
  width: number
  height: number
  borderWidth: number
  borderColor: number
  borderRadius?: number
  paddingLength: number
  containerID: number
  containerName: string
  content: string
  isEventCapture: number
}

// compileGrid の内部オプション。config 語彙 (セル定義) には載せない:
// - captureCellId: event 層を注入せず、この id のセル自身に isEventCapture=1 を与える
//   (status-line preset 専用。id 採番も 1 始まりになる)
// - fit: false で fitContent をスキップ (呼び出し元が幅/行数を保証済みの整形済み content 用)
export type CompileGridOpts = {
  captureCellId?: string
  fit?: boolean
}

// 1 行を px 幅に収める。超えれば末尾 … (… の px を残す)。for..of = code point 単位 = grapheme で
// 走査するためサロゲートペア / 絵文字を割らない。px 計測 (getTextWidth) なので全角も正しい。
function fitLine(line: string, maxPx: number): string {
  if (maxPx <= 0) return ''
  if (getTextWidth(line) <= maxPx) return line
  const ell = getTextWidth('…')
  let w = 0
  let out = ''
  for (const ch of line) {
    const cw = getTextWidth(ch)
    if (w + cw + ell > maxPx) break
    out += ch
    w += cw
  }
  return `${out}…`
}

// content を inner 矩形 (px) に収める: 各行を幅で切り、行数を innerH/LINE_H に制限。
function fitContent(content: string, innerW: number, innerH: number): string {
  const maxLines = Math.max(1, Math.floor(innerH / LINE_H))
  return content
    .split('\n')
    .slice(0, maxLines)
    .map((l) => fitLine(l, innerW))
    .join('\n')
}

// グリッド占有 (overlap 検出) を 1 セル単位で塗る / 判定する。
function markOccupied(grid: boolean[][], c: GridCell): void {
  for (let r = c.row; r < c.row + c.rowSpan; r++)
    for (let col = c.col; col < c.col + c.colSpan; col++) grid[r][col] = true
}
function overlaps(grid: boolean[][], c: GridCell): boolean {
  for (let r = c.row; r < c.row + c.rowSpan; r++)
    for (let col = c.col; col < c.col + c.colSpan; col++) if (grid[r][col]) return true
  return false
}

// セル定義の静的 validation。上限 (text ≤7 + event 1 = 8。captureCellId 指定時は注入なしで ≤8) /
// id 一意 / id 1〜16 文字 (SDK containerName 制限) / captureCellId の実在。
function validateCells(cells: GridCell[], capture?: string): void {
  const max = capture ? 8 : 7
  if (cells.length > max) throw new Error(`grid: text セルは最大 ${max}。${cells.length} 個指定`)
  if (capture && !cells.some((c) => c.id === capture))
    throw new Error(`grid: captureCellId '${capture}' のセルが無い`)
  const ids = new Set<string>()
  for (const c of cells) {
    if (c.id.length < 1 || c.id.length > 16)
      throw new Error(`grid: セル id '${c.id}' は 1〜16 文字 (SDK containerName 制限)`)
    if (c.id === 'evt')
      throw new Error(`grid: セル id 'evt' は予約済み (注入される event 層と衝突する)`)
    if (ids.has(c.id)) throw new Error(`grid: セル id '${c.id}' が重複`)
    ids.add(c.id)
  }
}

// event 層 (id 1, 全面透明)。declaration 順で最初に置く (後のセルが上に描画される)。
function eventLayer(): CompiledCell {
  return {
    xPosition: 0,
    yPosition: 0,
    width: GLASS_WIDTH,
    height: GLASS_HEIGHT,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 0,
    containerID: 1,
    containerName: 'evt',
    content: ' ', // 空不可。space 1 個 (不可視)
    isEventCapture: 1,
  }
}

// セル矩形を px へ変換する。edge-based 丸め: 隣接セルが隙間/重なり無く tile する
// (ROW_H=28.8 が小数なので round(span*ROW_H) の累積だと 1px ずれる)。
// 描画側 (glass-render の grid データ束縛) も同じ式で内寸を計算する。
export function cellRect(c: { col: number; row: number; colSpan: number; rowSpan: number }): {
  x: number
  y: number
  w: number
  h: number
} {
  const x = Math.round(c.col * COL_W)
  const y = Math.round(c.row * ROW_H)
  return {
    x,
    y,
    w: Math.round((c.col + c.colSpan) * COL_W) - x,
    h: Math.round((c.row + c.rowSpan) * ROW_H) - y,
  }
}

// 1 セルを px 座標へ変換する。
function compileCell(c: GridCell, id: number, opts: CompileGridOpts): CompiledCell {
  const border = Math.max(0, Math.min(5, c.border ?? 0))
  const padding = Math.max(0, c.padding ?? 0)
  const { x, y, w, h } = cellRect(c)
  const inset = 2 * (border + padding)
  const cell: CompiledCell = {
    xPosition: x,
    yPosition: y,
    width: w,
    height: h,
    borderWidth: border,
    borderColor: border > 0 ? 12 : 0,
    paddingLength: padding,
    containerID: id,
    containerName: c.id,
    content: opts.fit === false ? c.content : fitContent(c.content, w - inset, h - inset),
    isEventCapture: c.id === opts.captureCellId ? 1 : 0,
  }
  // radius 指定セルのみ borderRadius を持つ (未指定は PB default 0 に任せ、wire を旧実装と揃える)。
  if (c.radius !== undefined) cell.borderRadius = Math.max(0, Math.min(10, c.radius))
  return cell
}

// compiler: text セルのみ。既定では event 層 (全面透明 text, isEventCapture:1) を 1 つ注入し、
// セル id は 2 始まり。captureCellId 指定時は注入せず、そのセル自身が入力を受ける (id 1 始まり)。
// bounds / overlap / validateCells を満たさねば throw。
// containerName にはセル id をそのまま使う (textContainerUpgrade の宛先として安定)。
export function compileGrid(layout: GridLayout, opts: CompileGridOpts = {}): CompiledCell[] {
  const cols = layout.cols ?? GRID_COLS
  const rows = layout.rows ?? GRID_ROWS
  validateCells(layout.cells, opts.captureCellId)

  const grid: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false))
  const out: CompiledCell[] = opts.captureCellId ? [] : [eventLayer()]
  let id = opts.captureCellId ? 1 : 2
  for (const c of layout.cells) {
    if (c.col < 0 || c.row < 0 || c.col + c.colSpan > cols || c.row + c.rowSpan > rows)
      throw new Error(`grid: セル '${c.id}' が範囲外 (${cols}×${rows})`)
    if (overlaps(grid, c)) throw new Error(`grid: セル '${c.id}' が他セルと重なる`)
    markOccupied(grid, c)
    out.push(compileCell(c, id, opts))
    id++
  }
  return out
}

// status-line preset: 全面 1 cell (12×10)。従来の単一 'toolbar' container (glass.ts) と
// wire-identical なコンパイル結果になる (glass-layout.test.ts で payload を固定)。
// content は renderDeckPage が幅/行数を保証済みなので fit しない (fitLine を通すと
// detail 行の挙動が word-wrap → ellipsis に変わり描画不変にならない)。
export const STATUS_CELL_ID = 'toolbar'
export function compileStatusLine(content: string): CompiledCell {
  const cells = compileGrid(
    {
      cells: [
        {
          id: STATUS_CELL_ID,
          col: 0,
          row: 0,
          colSpan: GRID_COLS,
          rowSpan: GRID_ROWS,
          content,
          padding: GLASS_PADDING,
        },
      ],
    },
    { captureCellId: STATUS_CELL_ID, fit: false },
  )
  const cell = cells[0]
  if (!cell) throw new Error('status-line preset: compile 結果が空')
  return cell
}
