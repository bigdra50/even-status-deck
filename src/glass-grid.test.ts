// grid ページ (Issue #17: cell→segment データ束縛) の描画テスト。
// セル content の解決 / セル幅 justify / 行容量 clamp / ページ skip / 平文化を固定する。
// 実行: bun test src/glass-grid.test.ts
import { expect, test } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import {
  activeView,
  BUILTIN_SOURCE_ID,
  type Config,
  emptyConfig,
  type GlassPage,
  type GridCellSpec,
  RIGHT_DIVIDER,
} from './config'
import { cellRect } from './glass-layout'
import {
  buildRuntimePages,
  compileGridPage,
  type GlassData,
  gridCellLines,
  gridPageOf,
  gridPageText,
  MAX_ROWS,
  renderRuntimePage,
} from './glass-render'
import type { StatusDoc } from './status-types'

const G2_LEVEL = `${BUILTIN_SOURCE_ID}|g2|level`
const CLOCK_DT = `${BUILTIN_SOURCE_ID}|clock|datetime`

function emptyRows(): string[][] {
  return Array.from({ length: MAX_ROWS }, () => [])
}

function builtinDoc(): StatusDoc {
  return {
    version: 1,
    ts: 0,
    groups: [
      { id: 'clock', label: '', segments: [{ id: 'datetime', label: '', value: '12:00' }] },
      { id: 'g2', label: '', segments: [{ id: 'level', label: 'Bat', value: '80%' }] },
    ],
  }
}

function makeData(pages?: GlassPage[]): GlassData {
  const config: Config = emptyConfig()
  if (pages) activeView(config).pages = pages
  return { config, statuses: { [BUILTIN_SOURCE_ID]: builtinDoc() } }
}

function gridPage(
  cells: GridCellSpec[],
  customLabels: Record<string, { text: string }> = {},
): GlassPage {
  return {
    id: 'gp',
    name: 'GP',
    layout: { rows: emptyRows(), customLabels },
    mode: 'grid',
    grid: { cells },
  }
}

const cellSpec = (over: Partial<GridCellSpec> = {}): GridCellSpec => ({
  id: 'a',
  col: 0,
  row: 0,
  colSpan: 6,
  rowSpan: 2,
  rows: [[G2_LEVEL]],
  ...over,
})

test('compileGridPage: セル content を live status から解決し、event 層 + セル別コンテナにする', () => {
  const page = gridPage([
    cellSpec({ id: 'bat', rows: [[G2_LEVEL]] }),
    cellSpec({ id: 'clk', col: 6, rows: [[CLOCK_DT]] }),
  ])
  const { texts, images } = compileGridPage(page, makeData([page]))
  expect(images).toHaveLength(0)
  expect(texts).toHaveLength(3)
  expect(texts[0]).toMatchObject({ containerName: 'evt', isEventCapture: 1 })
  expect(texts[1]).toMatchObject({ containerName: 'bat' })
  expect(texts[1]?.content).toContain('Bat 80%')
  expect(texts[2]).toMatchObject({ containerName: 'clk' })
  expect(texts[2]?.content).toContain('12:00')
})

test('compileGridPage: image cell は text と分離し別レンジの containerID を持つ', () => {
  const page = gridPage([
    cellSpec({ id: 'bat', rows: [[G2_LEVEL]] }),
    cellSpec({
      id: 'spark',
      col: 6,
      colSpan: 4,
      rowSpan: 2,
      rows: [],
      kind: 'image',
      image: { source: 'sparkline', segKey: G2_LEVEL },
    }),
  ])
  const { texts, images } = compileGridPage(page, makeData([page]))
  expect(texts.map((t) => t.containerName)).toEqual(['evt', 'bat'])
  expect(images).toHaveLength(1)
  expect(images[0]).toMatchObject({
    containerID: 30, // IMAGE_CONTAINER_ID_BASE (text 1-8 / overlay dot 90+ と非衝突)
    containerName: 'spark',
    xPosition: 288,
    yPosition: 0,
    width: 192,
    height: 58,
  })
  expect(images[0]?.image).toEqual({ source: 'sparkline', segKey: G2_LEVEL })
})

test('gridCellLines: セル内の @right はセル内寸幅で右寄せされる (px 計測で枠内)', () => {
  const cell = cellSpec({ rows: [[G2_LEVEL, RIGHT_DIVIDER, CLOCK_DT]] })
  const [line] = gridCellLines(cell, {}, makeData())
  expect(line).toMatch(/^G2 Bat 80% +12:00$/) // g2 group は default-label ON ('G2 ' 前置)
  const { w } = cellRect(cell)
  expect(getTextWidth(line ?? '')).toBeLessThanOrEqual(w)
})

test('gridCellLines: 左+右がセル幅を超えても @right クラスタは欠落しない (左を切り詰め)', () => {
  // colSpan 3 = 144px。左 (G2 Bat 80%) + 右 (12:00) は収まらない → 左が … 切り詰めされ右が残る。
  const cell = cellSpec({ colSpan: 3, rows: [[G2_LEVEL, RIGHT_DIVIDER, CLOCK_DT]] })
  const [line] = gridCellLines(cell, {}, makeData())
  expect(line?.endsWith('12:00')).toBe(true)
  const { w } = cellRect(cell)
  expect(getTextWidth(line ?? '')).toBeLessThanOrEqual(w)
})

test('gridCellLines: 行数はセル内寸の行容量に clamp (rowSpan1 ≒28px は 1 行)', () => {
  const cell = cellSpec({ rowSpan: 1, rows: [[G2_LEVEL], [CLOCK_DT], [G2_LEVEL]] })
  const lines = gridCellLines(cell, {}, makeData())
  expect(lines).toHaveLength(1)
})

test('gridCellLines: custom label は page.layout.customLabels から解決される', () => {
  const page = gridPage([cellSpec({ rows: [['@customLabel:x', G2_LEVEL]] })], {
    x: { text: 'HOME' },
  })
  const cell = page.grid?.cells[0]
  const lines = cell ? gridCellLines(cell, page.layout.customLabels, makeData([page])) : []
  expect(lines[0]).toContain('HOME')
})

test('buildRuntimePages: grid ページは grid の key で描画可否を判定する', () => {
  const live = gridPage([cellSpec()])
  const ghost = {
    ...gridPage([cellSpec({ rows: [[`${BUILTIN_SOURCE_ID}|g2|ghost`]] })]),
    id: 'g2p',
  }
  const pages = buildRuntimePages(makeData([live, ghost]))
  expect(pages).toHaveLength(1)
  expect(pages[0]).toMatchObject({ kind: 'custom', page: { id: 'gp' } })
})

test('gridPageText: セルを row,col 順に平文化し MAX_ROWS に clamp', () => {
  const page = gridPage([
    cellSpec({ id: 'b', col: 6, row: 2, rows: [[CLOCK_DT]] }),
    cellSpec({ id: 'a', row: 0, rows: [[G2_LEVEL]] }),
  ])
  const text = gridPageText(page, makeData([page]))
  const lines = text.split('\n')
  expect(lines[0]).toContain('Bat 80%') // row0 のセルが先
  expect(lines[1]).toContain('12:00')
  expect(lines.length).toBeLessThanOrEqual(MAX_ROWS)
})

test('renderRuntimePage: grid ページの文字列表現は平文化と一致 (overlay 下地経路)', () => {
  const page = gridPage([cellSpec()])
  const d = makeData([page])
  const rt = buildRuntimePages(d)[0]
  expect(rt && gridPageOf(rt)).toBe(page)
  if (rt) expect(renderRuntimePage(rt, d, MAX_ROWS)).toBe(gridPageText(page, d))
})

test('mode が grid でも grid 実体が無ければ linear として描画 (gridPageOf は null)', () => {
  const page: GlassPage = {
    id: 'p',
    name: 'P',
    layout: { rows: [[G2_LEVEL], ...emptyRows().slice(1)], customLabels: {} },
    mode: 'grid',
  }
  const d = makeData([page])
  const rt = buildRuntimePages(d)[0]
  expect(rt ? gridPageOf(rt) : undefined).toBeNull()
})
