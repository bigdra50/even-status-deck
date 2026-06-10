// grid 定義 (GlassPage.grid / mode) の正規化・移行・visitor 連携のテスト。
// CONFIG_VERSION 据え置き (additive) で grid が保存/復元され、source 削除・remap・orphan 掃除が
// grid セル内の segKey にも届くことを固定する。
// 実行: bun test src/config/grid.test.ts
import { expect, test } from 'bun:test'
import {
  activeProfile,
  addServer,
  BUILTIN_SOURCE_ID,
  type Config,
  cloneGlassPage,
  emptyConfig,
  type GlassPage,
  type GridCellSpec,
  migrate,
  removeSource,
} from './index'

const G2_LEVEL = `${BUILTIN_SOURCE_ID}|g2|level`

function emptyRows(): string[][] {
  return Array.from({ length: 10 }, () => [])
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

function withGridPage(cfg: Config, cells: unknown[], mode: unknown = 'grid'): void {
  ;(activeProfile(cfg).view as { pages: unknown }).pages = [
    {
      id: 'p1',
      name: 'P1',
      layout: { rows: emptyRows(), customLabels: {} },
      mode,
      grid: { cells },
    },
  ]
}

function migratedPage(cfg: Config): GlassPage | undefined {
  return activeProfile(migrate(cfg as unknown as Record<string, unknown>)).view.pages?.[0]
}

test('migrate v5: 正常な grid + mode は保存される (additive・version 据え置き)', () => {
  const cfg = emptyConfig()
  withGridPage(cfg, [cellSpec()])
  const page = migratedPage(cfg)
  expect(page?.mode).toBe('grid')
  expect(page?.grid?.cells).toHaveLength(1)
  expect(page?.grid?.cells[0]).toMatchObject({ id: 'a', col: 0, row: 0, colSpan: 6, rowSpan: 2 })
  expect(page?.grid?.cells[0]?.rows[0]).toEqual([G2_LEVEL])
})

test('migrate: mode=grid でも grid 実体が無ければ mode を落とす (単一分岐軸の整合)', () => {
  const cfg = emptyConfig()
  ;(activeProfile(cfg).view as { pages: unknown }).pages = [
    { id: 'p1', name: 'P1', layout: { rows: emptyRows(), customLabels: {} }, mode: 'grid' },
  ]
  const page = migratedPage(cfg)
  expect(page?.mode).toBeUndefined()
  expect(page?.grid).toBeUndefined()
})

test('migrate: grid ページは layout が壊れていても空 layout で生かす', () => {
  const cfg = emptyConfig()
  ;(activeProfile(cfg).view as { pages: unknown }).pages = [
    { id: 'p1', name: 'P1', layout: null, mode: 'grid', grid: { cells: [cellSpec()] } },
  ]
  const page = migratedPage(cfg)
  expect(page?.grid?.cells).toHaveLength(1)
  expect(page?.layout.rows).toHaveLength(10)
})

test('normalize: 範囲外 / id 重複 / 17 文字 id / 予約 id (evt) / 非整数座標のセルは drop', () => {
  const cfg = emptyConfig()
  withGridPage(cfg, [
    cellSpec({ id: 'ok' }),
    cellSpec({ id: 'oob', col: 8, colSpan: 6, row: 4 }), // col+span > 12
    cellSpec({ id: 'ok', row: 4 }), // id 重複
    cellSpec({ id: 'x'.repeat(17), row: 6 }),
    cellSpec({ id: 'evt', row: 6 }), // 予約 id (event 層と衝突)
    cellSpec({ id: 'frac', row: 8, col: 0.5 as unknown as number }),
  ])
  const page = migratedPage(cfg)
  expect(page?.grid?.cells.map((c) => c.id)).toEqual(['ok'])
})

test('migrate: cells が配列でない壊れた grid でもクラッシュせず grid を落とす', () => {
  const cfg = emptyConfig()
  ;(activeProfile(cfg).view as { pages: unknown }).pages = [
    {
      id: 'p1',
      name: 'P1',
      layout: { rows: emptyRows(), customLabels: {} },
      mode: 'grid',
      grid: { cells: {} }, // 壊れた形 (consolidateClock が normalize 前に走る経路で過去クラッシュ)
    },
  ]
  const page = migratedPage(cfg)
  expect(page?.grid).toBeUndefined()
  expect(page?.mode).toBeUndefined()
})

test('normalize: overlap は定義順で先勝ち (後のセルを drop)', () => {
  const cfg = emptyConfig()
  withGridPage(cfg, [cellSpec({ id: 'first' }), cellSpec({ id: 'second', col: 3 })])
  const page = migratedPage(cfg)
  expect(page?.grid?.cells.map((c) => c.id)).toEqual(['first'])
})

test('normalize: 枠線は rowSpan>=2 のみ (1 行セルの border は落ちる)', () => {
  const cfg = emptyConfig()
  withGridPage(cfg, [
    cellSpec({ id: 'thin', rowSpan: 1, border: 2 }),
    cellSpec({ id: 'tall', row: 2, rowSpan: 2, border: 2, radius: 4 }),
  ])
  const cells = migratedPage(cfg)?.grid?.cells
  expect(cells?.[0]?.border).toBeUndefined()
  expect(cells?.[1]?.border).toBe(2)
  expect(cells?.[1]?.radius).toBe(4)
})

test('normalize: 行はセル容量まで (rowSpan1 の隠れ 2 行目は drop → chip は棚に導出される)', () => {
  const cfg = emptyConfig()
  const hidden = `${BUILTIN_SOURCE_ID}|clock|datetime`
  withGridPage(cfg, [cellSpec({ rowSpan: 1, rows: [[G2_LEVEL], [hidden]] })])
  const cell = migratedPage(cfg)?.grid?.cells[0]
  expect(cell?.rows).toEqual([[G2_LEVEL]]) // 容量 1 行: 隠れ行は保持しない (silent loss 防止)
})

test('normalize: border+padding は容量を削る (rowSpan2 でも 1 行に clamp)', () => {
  const cfg = emptyConfig()
  const second = `${BUILTIN_SOURCE_ID}|clock|datetime`
  // 58px - 2*(2+6)=16 → 42px/27 = 容量 1 行
  withGridPage(cfg, [cellSpec({ rowSpan: 2, border: 2, padding: 6, rows: [[G2_LEVEL], [second]] })])
  const cell = migratedPage(cfg)?.grid?.cells[0]
  expect(cell?.rows).toEqual([[G2_LEVEL]])
})

test('normalize: セルは 7 個まで (8 個目以降は drop)', () => {
  const cfg = emptyConfig()
  withGridPage(
    cfg,
    Array.from({ length: 9 }, (_, i) =>
      cellSpec({ id: `c${i}`, col: 0, colSpan: 12, row: i, rowSpan: 1 }),
    ),
  )
  expect(migratedPage(cfg)?.grid?.cells).toHaveLength(7)
})

test('migrate: grid セル内の orphan source chip も掃除される (pruneOrphans)', () => {
  const cfg = emptyConfig()
  withGridPage(cfg, [cellSpec({ rows: [[G2_LEVEL, 'ghost.source|grp|seg']] })])
  const page = migratedPage(cfg)
  expect(page?.grid?.cells[0]?.rows[0]).toEqual([G2_LEVEL])
})

test('removeSource: grid セル内の当該 source chip を除去する', () => {
  const cfg = emptyConfig()
  const src = addServer(cfg, 'Test', 'http://x')
  const key = `${src.id}|grp|seg`
  activeProfile(cfg).view.pages = [
    {
      id: 'p1',
      name: 'P1',
      layout: { rows: emptyRows(), customLabels: {} },
      mode: 'grid',
      grid: { cells: [cellSpec({ rows: [[key, G2_LEVEL]] })] },
    },
  ]
  removeSource(cfg, src.id)
  expect(activeProfile(cfg).view.pages?.[0]?.grid?.cells[0]?.rows[0]).toEqual([G2_LEVEL])
})

test('migrate: grid セル内の旧 clock time/date も datetime へ畳む (page 単位 dedupe)', () => {
  const cfg = emptyConfig()
  const timeKey = `${BUILTIN_SOURCE_ID}|clock|time`
  const dateKey = `${BUILTIN_SOURCE_ID}|clock|date`
  const dtKey = `${BUILTIN_SOURCE_ID}|clock|datetime`
  withGridPage(cfg, [
    cellSpec({ id: 'a', rows: [[timeKey]] }),
    cellSpec({ id: 'b', row: 2, rows: [[dateKey]] }),
  ])
  const cells = migratedPage(cfg)?.grid?.cells
  expect(cells?.[0]?.rows[0]).toEqual([dtKey])
  expect(cells?.[1]?.rows[0]).toEqual([]) // grid 集合内で dedupe (datetime は 1 箇所)
})

test('cloneGlassPage: grid を deep copy (複製編集が元に波及しない)', () => {
  const page: GlassPage = {
    id: 'p',
    name: 'P',
    layout: { rows: emptyRows(), customLabels: {} },
    mode: 'grid',
    grid: { cells: [cellSpec()] },
  }
  const copy = cloneGlassPage(page)
  copy.grid?.cells[0]?.rows[0]?.push('extra')
  if (copy.grid?.cells[0]) copy.grid.cells[0].col = 6
  expect(page.grid?.cells[0]?.rows[0]).toEqual([G2_LEVEL])
  expect(page.grid?.cells[0]?.col).toBe(0)
})

test('normalize: image cell は語彙内 icon / segKey 形式 / サイズ制約を満たすものだけ残る', () => {
  const cfg = emptyConfig()
  withGridPage(cfg, [
    cellSpec({
      id: 'icon',
      colSpan: 2,
      rowSpan: 2,
      rows: [],
      kind: 'image',
      image: { source: 'icon', icon: 'battery' },
    }),
    cellSpec({
      id: 'spark',
      col: 2,
      colSpan: 4,
      rowSpan: 2,
      rows: [],
      kind: 'image',
      image: { source: 'sparkline', segKey: G2_LEVEL },
    }),
    cellSpec({
      id: 'badicon',
      col: 6,
      colSpan: 2,
      rowSpan: 2,
      rows: [],
      kind: 'image',
      image: { source: 'icon', icon: 'nope' },
    }),
    cellSpec({
      id: 'badkey',
      col: 8,
      colSpan: 2,
      rowSpan: 2,
      rows: [],
      kind: 'image',
      image: { source: 'sparkline', segKey: 'not-a-key' },
    }),
    // rowSpan 6 = 173px > 144 (SDK height 上限) → drop
    cellSpec({
      id: 'tall',
      col: 0,
      row: 2,
      colSpan: 4,
      rowSpan: 6,
      rows: [],
      kind: 'image',
      image: { source: 'icon', icon: 'sun' },
    }),
  ])
  const cells = migratedPage(cfg)?.grid?.cells
  expect(cells?.map((c) => c.id)).toEqual(['icon', 'spark'])
  expect(cells?.[0]?.kind).toBe('image')
  expect(cells?.[0]?.image).toEqual({ source: 'icon', icon: 'battery' })
})

test('normalize: image cell は 4 枚まで・text 7 枠とは別勘定', () => {
  const cfg = emptyConfig()
  const imgCell = (i: number) =>
    cellSpec({
      id: `i${i}`,
      col: (i % 6) * 2,
      row: Math.floor(i / 6) * 2,
      colSpan: 2,
      rowSpan: 2,
      rows: [],
      kind: 'image',
      image: { source: 'icon', icon: 'sun' },
    })
  withGridPage(cfg, [
    ...Array.from({ length: 6 }, (_, i) => imgCell(i)),
    cellSpec({ id: 'txt', col: 0, row: 8, colSpan: 12, rowSpan: 1 }),
  ])
  const cells = migratedPage(cfg)?.grid?.cells
  expect(cells?.filter((c) => c.kind === 'image')).toHaveLength(4)
  expect(cells?.some((c) => c.id === 'txt')).toBe(true) // text は別勘定で生存
})
