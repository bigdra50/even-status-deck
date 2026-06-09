// grid エディタの純粋ロジック (Issue #17)。DOM/ctx に依存しない: 配置検証・空き矩形探索・
// セル行容量。UI (glass-edit.ts) とアクション (actions.ts) がここを共有する。
import type { GlassGrid, GridCellSpec } from '../config'
import { cellRect, LINE_H } from '../glass-layout'
import { GRID_COLS, GRID_ROWS } from '../glass-types'

export type CellRectSpec = Pick<GridCellSpec, 'col' | 'row' | 'colSpan' | 'rowSpan'>

// 2 つのセル矩形が重なるか (半開区間の交差判定)。
function intersects(a: CellRectSpec, b: CellRectSpec): boolean {
  return (
    a.col < b.col + b.colSpan &&
    b.col < a.col + a.colSpan &&
    a.row < b.row + b.rowSpan &&
    b.row < a.row + a.rowSpan
  )
}

// rect が 12×10 に収まり、exceptId 以外のどのセルとも重ならないか。
export function canPlace(grid: GlassGrid, rect: CellRectSpec, exceptId?: string): boolean {
  if (rect.col < 0 || rect.row < 0 || rect.colSpan < 1 || rect.rowSpan < 1) return false
  if (rect.col + rect.colSpan > GRID_COLS || rect.row + rect.rowSpan > GRID_ROWS) return false
  return grid.cells.every((c) => c.id === exceptId || !intersects(c, rect))
}

// 新規セルの既定サイズ候補 (大きい順に試す)。先頭は 2 行 = 枠線が許される最小高。
const NEW_CELL_SIZES: ReadonlyArray<readonly [number, number]> = [
  [6, 2],
  [4, 2],
  [12, 1],
  [6, 1],
  [4, 1],
  [3, 1],
  [2, 1],
  [1, 1],
]

// 空き矩形を探す (サイズ候補を大きい順に、左上から走査)。全滅なら null。
export function findFreeRect(grid: GlassGrid): CellRectSpec | null {
  for (const [colSpan, rowSpan] of NEW_CELL_SIZES) {
    for (let row = 0; row + rowSpan <= GRID_ROWS; row++) {
      for (let col = 0; col + colSpan <= GRID_COLS; col++) {
        const rect = { col, row, colSpan, rowSpan }
        if (canPlace(grid, rect)) return rect
      }
    }
  }
  return null
}

// 既存セル id と重複しない次のセル id ('cellN')。
export function nextCellId(grid: GlassGrid): string {
  const used = new Set(grid.cells.map((c) => c.id))
  for (let n = 1; ; n++) {
    const id = `cell${n}`
    if (!used.has(id)) return id
  }
}

// セルの行容量 (glass-render の gridCellLines と同じ式)。
export function cellCapacity(cell: GridCellSpec): number {
  const { h } = cellRect(cell)
  const inset = 2 * ((cell.border ?? 0) + (cell.padding ?? 0))
  return Math.max(1, Math.floor((h - inset) / LINE_H))
}

// grid 内の全配置 key (placed 集合。Unplaced 棚の導出に使う)。@right 区切りは含めない。
export function gridPlacedKeys(grid: GlassGrid): Set<string> {
  const placed = new Set<string>()
  for (const c of grid.cells) for (const row of c.rows) for (const k of row) placed.add(k)
  return placed
}
