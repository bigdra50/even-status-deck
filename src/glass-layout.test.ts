// grid compiler のテスト。特に status-line preset (compileStatusLine) が従来の
// 単一 'toolbar' container (glass.ts 旧 literal) と wire-identical であることを固定する
// (描画不変リファクタの契約。toJson() の key 集合まで一致 = borderRadius を出さない)。
// 実行: bun test src/glass-layout.test.ts
import { expect, test } from 'bun:test'
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import {
  compileGrid,
  compileStatusLine,
  GRID_COLS,
  GRID_ROWS,
  type GridCell,
  STATUS_CELL_ID,
} from './glass-layout'

const cell = (over: Partial<GridCell> = {}): GridCell => ({
  id: 'a',
  col: 0,
  row: 0,
  colSpan: 2,
  rowSpan: 1,
  content: 'x',
  ...over,
})

// ── status-line preset (描画不変の契約) ──

test('compileStatusLine: 旧 singleContainer と wire-identical (toJson の key 集合まで一致)', () => {
  const content = 'line1\nline2  right'
  const wire = new TextContainerProperty(compileStatusLine(content)).toJson()
  // glass.ts 旧実装 (PR #77 時点) の literal をそのまま固定。borderRadius キーは存在しない。
  expect(wire).toEqual({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 8,
    containerID: 1,
    containerName: 'toolbar',
    content,
    isEventCapture: 1,
  })
})

test('compileStatusLine: content を一切加工しない (fit なし。長行も 10 行超も素通し)', () => {
  const long = 'W'.repeat(200) // 確実に 560px 超
  const many = Array.from({ length: 14 }, (_, i) => `r${i}`).join('\n') // 10 行超
  expect(compileStatusLine(long).content).toBe(long)
  expect(compileStatusLine(many).content).toBe(many)
})

test('compileStatusLine: セル id がそのまま containerName / 入力 capture を担う', () => {
  const c = compileStatusLine('x')
  expect(c.containerID).toBe(1)
  expect(c.containerName).toBe(STATUS_CELL_ID)
  expect(c.isEventCapture).toBe(1)
})

// ── compileGrid 既定経路 (overlay が使う形) ──

test('compileGrid: event 層 (id1) を注入し、セルは id2 から。containerName はセル id', () => {
  const out = compileGrid({ cells: [cell({ id: 'top' }), cell({ id: 'box', row: 2 })] })
  expect(out).toHaveLength(3)
  expect(out[0]).toMatchObject({ containerID: 1, containerName: 'evt', isEventCapture: 1 })
  expect(out[1]).toMatchObject({ containerID: 2, containerName: 'top', isEventCapture: 0 })
  expect(out[2]).toMatchObject({ containerID: 3, containerName: 'box', isEventCapture: 0 })
})

test('compileGrid: radius 未指定セルは borderRadius キー自体を持たない (PB default に任せる)', () => {
  const out = compileGrid({ cells: [cell(), cell({ id: 'r', row: 2, radius: 8 })] })
  expect('borderRadius' in (out[1] as object)).toBe(false)
  expect(out[2]?.borderRadius).toBe(8)
  // wire (toJson) にも出ない
  expect('borderRadius' in new TextContainerProperty(out[1]).toJson()).toBe(false)
})

test('compileGrid: 全面 1 セルは 576×288 にぴったり一致 (edge-based 丸め)', () => {
  const out = compileGrid({
    cells: [cell({ colSpan: GRID_COLS, rowSpan: GRID_ROWS })],
  })
  expect(out[1]).toMatchObject({ xPosition: 0, yPosition: 0, width: 576, height: 288 })
})

test('compileGrid: 隣接セルが隙間なく tile する (ROW_H=28.8 の丸め累積ズレなし)', () => {
  const out = compileGrid({
    cells: [
      cell({ id: 'r0', row: 0, rowSpan: 1 }),
      cell({ id: 'r1', row: 1, rowSpan: 1 }),
      cell({ id: 'r2', row: 2, rowSpan: 1 }),
    ],
  })
  const [, r0, r1, r2] = out
  expect((r0?.yPosition ?? 0) + (r0?.height ?? 0)).toBe(r1?.yPosition)
  expect((r1?.yPosition ?? 0) + (r1?.height ?? 0)).toBe(r2?.yPosition)
})

test('compileGrid: 既定では長い content を fitContent で … 切り詰めする', () => {
  const long = 'W'.repeat(200)
  const out = compileGrid({ cells: [cell({ content: long })] })
  expect(out[1]?.content.endsWith('…')).toBe(true)
  expect(out[1]?.content).not.toBe(long)
})

// ── captureCellId オプション ──

test('captureCellId: event 層を注入せず id1 始まり、該当セルのみ isEventCapture=1', () => {
  const out = compileGrid(
    { cells: [cell({ id: 'main' }), cell({ id: 'sub', row: 2 })] },
    {
      captureCellId: 'main',
    },
  )
  expect(out).toHaveLength(2)
  expect(out[0]).toMatchObject({ containerID: 1, containerName: 'main', isEventCapture: 1 })
  expect(out[1]).toMatchObject({ containerID: 2, containerName: 'sub', isEventCapture: 0 })
})

test('captureCellId: 存在しないセル id を指すと throw', () => {
  expect(() => compileGrid({ cells: [cell()] }, { captureCellId: 'nope' })).toThrow(/captureCellId/)
})

// ── validation ──

test('セル id の重複 / 16 文字超 / 空は throw', () => {
  expect(() => compileGrid({ cells: [cell(), cell({ row: 2 })] })).toThrow(/重複/)
  expect(() => compileGrid({ cells: [cell({ id: 'x'.repeat(17) })] })).toThrow(/16/)
  expect(() => compileGrid({ cells: [cell({ id: '' })] })).toThrow(/16/)
})

test('セル数上限: 既定 7 (event 層+1=8)、captureCellId 指定時は 8', () => {
  const eight = Array.from({ length: 8 }, (_, i) => cell({ id: `c${i}`, row: i }))
  expect(() => compileGrid({ cells: eight })).toThrow(/最大 7/)
  expect(compileGrid({ cells: eight }, { captureCellId: 'c0' })).toHaveLength(8)
  const nine = [...eight, cell({ id: 'c8', row: 8 })]
  expect(() => compileGrid({ cells: nine }, { captureCellId: 'c0' })).toThrow(/最大 8/)
})

test('範囲外 / 重なりは throw', () => {
  expect(() => compileGrid({ cells: [cell({ col: 11, colSpan: 2 })] })).toThrow(/範囲外/)
  expect(() =>
    compileGrid({ cells: [cell({ colSpan: 4 }), cell({ id: 'b', col: 2, colSpan: 4 })] }),
  ).toThrow(/重なる/)
})
