// grid エディタの純粋ロジック (配置検証・空き矩形探索・容量) のテスト。
// 実行: bun test src/companion/grid-edit.test.ts
import { expect, test } from 'bun:test'
import type { GlassGrid, GridCellSpec } from '../config'
import { canPlace, cellCapacity, findFreeRect, gridPlacedKeys, nextCellId } from './grid-edit'

const cell = (over: Partial<GridCellSpec> = {}): GridCellSpec => ({
  id: 'a',
  col: 0,
  row: 0,
  colSpan: 6,
  rowSpan: 2,
  rows: [],
  ...over,
})
const grid = (...cells: GridCellSpec[]): GlassGrid => ({ cells })

test('canPlace: 範囲内・非重複のみ true (自分自身は exceptId で除外)', () => {
  const g = grid(cell())
  expect(canPlace(g, { col: 6, row: 0, colSpan: 6, rowSpan: 2 })).toBe(true)
  expect(canPlace(g, { col: 3, row: 1, colSpan: 6, rowSpan: 2 })).toBe(false) // 重なり
  expect(canPlace(g, { col: 8, row: 0, colSpan: 6, rowSpan: 1 })).toBe(false) // 範囲外
  expect(canPlace(g, { col: 0, row: 0, colSpan: 0, rowSpan: 1 })).toBe(false) // span<1
  expect(canPlace(g, { col: 0, row: 0, colSpan: 6, rowSpan: 3 }, 'a')).toBe(true) // 自分を除外して拡大
})

test('findFreeRect: 空きが減るほど小さい矩形へフォールバックし、満杯で null', () => {
  expect(findFreeRect(grid())).toEqual({ col: 0, row: 0, colSpan: 6, rowSpan: 2 })
  // 全面 1 セルで占有 → 空き無し
  expect(findFreeRect(grid(cell({ colSpan: 12, rowSpan: 10 })))).toBeNull()
  // 下 1 行だけ空き → 12×1 が入る
  const g = grid(cell({ colSpan: 12, rowSpan: 9 }))
  expect(findFreeRect(g)).toEqual({ col: 0, row: 9, colSpan: 12, rowSpan: 1 })
})

test('nextCellId: 既存と重複しない cellN を払い出す', () => {
  expect(nextCellId(grid())).toBe('cell1')
  expect(nextCellId(grid(cell({ id: 'cell1' }), cell({ id: 'cell2', row: 2 })))).toBe('cell3')
})

test('cellCapacity: rowSpan1=1 行 / rowSpan2=2 行 / border+padding は容量を削る', () => {
  expect(cellCapacity(cell({ rowSpan: 1 }))).toBe(1)
  expect(cellCapacity(cell({ rowSpan: 2 }))).toBe(2)
  expect(cellCapacity(cell({ rowSpan: 10, colSpan: 12 }))).toBe(10)
  // 58px - 2*(2+6)=16 → 42px / 27 → 1 行
  expect(cellCapacity(cell({ rowSpan: 2, border: 2, padding: 6 }))).toBe(1)
})

test('gridPlacedKeys: 全セルの全行の key を集める', () => {
  const g = grid(
    cell({ id: 'x', rows: [['k1'], ['k2', 'k3']] }),
    cell({ id: 'y', row: 2, rows: [['k4']] }),
  )
  expect([...gridPlacedKeys(g)].sort()).toEqual(['k1', 'k2', 'k3', 'k4'])
})
