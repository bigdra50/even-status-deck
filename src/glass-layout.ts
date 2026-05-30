// グリッドレイアウト compiler (tasks/roadmap-ideas.md「グリッドレイアウト設計」の MVP)。
// layout 定義 (セルの grid 座標) → SDK の TextContainerProperty 互換オブジェクト配列へ
// 決定的に変換する。MVP は text セルのみ・固定 12×10。各セルを px で座標配置するので、
// 列は座標で厳密に揃う (線形 status line の space パディングと違い proportional フォントでも揃う)。
import { getTextWidth } from '@evenrealities/pretext'
import { GLASS_HEIGHT, GLASS_WIDTH } from './glass-render'

export const GRID_COLS = 12
export const GRID_ROWS = 10
const COL_W = GLASS_WIDTH / GRID_COLS // 48
const ROW_H = GLASS_HEIGHT / GRID_ROWS // 28.8
const LINE_H = 27 // glass-render の line-height と一致

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
export type CompiledCell = {
  xPosition: number
  yPosition: number
  width: number
  height: number
  borderWidth: number
  borderColor: number
  borderRadius: number
  paddingLength: number
  containerID: number
  containerName: string
  content: string
  isEventCapture: number
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

// MVP compiler: text セルのみ。event 層 (全面透明 text, isEventCapture:1) を 1 つ注入する。
// 上限: user text ≤7 + event 1 = 8 (SDK の text 最大 8)。bounds / overlap / 上限を満たさねば throw。
export function compileGrid(layout: GridLayout): CompiledCell[] {
  const cols = layout.cols ?? GRID_COLS
  const rows = layout.rows ?? GRID_ROWS
  if (layout.cells.length > 7)
    throw new Error(`grid: text セルは最大 7 (event 層 +1 = 8)。${layout.cells.length} 個指定`)

  const grid: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false))
  // event 層 (id 1, 全面透明)。declaration 順で最初に置く (後のセルが上に描画される)。
  const out: CompiledCell[] = [
    {
      xPosition: 0,
      yPosition: 0,
      width: GLASS_WIDTH,
      height: GLASS_HEIGHT,
      borderWidth: 0,
      borderColor: 0,
      borderRadius: 0,
      paddingLength: 0,
      containerID: 1,
      containerName: 'evt',
      content: ' ', // 空不可。space 1 個 (不可視)
      isEventCapture: 1,
    },
  ]
  let id = 2
  for (const c of layout.cells) {
    if (c.col < 0 || c.row < 0 || c.col + c.colSpan > cols || c.row + c.rowSpan > rows)
      throw new Error(`grid: セル '${c.id}' が範囲外 (${cols}×${rows})`)
    if (overlaps(grid, c)) throw new Error(`grid: セル '${c.id}' が他セルと重なる`)
    markOccupied(grid, c)

    const border = Math.max(0, Math.min(5, c.border ?? 0))
    const padding = Math.max(0, c.padding ?? 0)
    const x = Math.round(c.col * COL_W)
    const y = Math.round(c.row * ROW_H)
    // edge-based 丸め: 隣接セルが隙間/重なり無く tile する (ROW_H=28.8 が小数なので
    // round(span*ROW_H) の累積だと 1px ずれる)。1 行セル (rowSpan=1) を積むときに効く。
    const w = Math.round((c.col + c.colSpan) * COL_W) - x
    const h = Math.round((c.row + c.rowSpan) * ROW_H) - y
    const inset = 2 * (border + padding)
    out.push({
      xPosition: x,
      yPosition: y,
      width: w,
      height: h,
      borderWidth: border,
      borderColor: border > 0 ? 12 : 0,
      borderRadius: Math.max(0, Math.min(10, c.radius ?? 0)),
      paddingLength: padding,
      containerID: id,
      containerName: `c${id}`,
      content: fitContent(c.content, w - inset, h - inset),
      isEventCapture: 0,
    })
    id++
  }
  return out
}
