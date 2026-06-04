// glass マルチページ (RuntimePage) 描画ロジックの回帰テスト。
// 実行: bun test src/glass-render.test.ts
import { expect, test } from 'bun:test'
import { activeView, BUILTIN_SOURCE_ID, type Config, emptyConfig, type GlassPage } from './config'
import {
  buildRuntimePages,
  type GlassData,
  layoutLines,
  MAX_ROWS,
  renderDeckPage,
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

// pages を設定した GlassData。withStatus=false なら status を入れない (auto が summary 1 枚になる)。
function makeData(pages?: GlassPage[], withStatus = true): GlassData {
  const config: Config = emptyConfig()
  if (pages) activeView(config).pages = pages
  const statuses: Record<string, StatusDoc | null> = withStatus
    ? { [BUILTIN_SOURCE_ID]: builtinDoc() }
    : {}
  return { config, statuses }
}

// 先頭行に rows0 を置いた 1 ページ。
function page(
  id: string,
  rows0: string[],
  customLabels: Record<string, { text: string }> = {},
): GlassPage {
  const rows = emptyRows()
  rows[0] = rows0
  return { id, name: id.toUpperCase(), layout: { rows, customLabels } }
}

test('buildRuntimePages: auto デッキは summary 先頭 + group detail', () => {
  const pages = buildRuntimePages(makeData())
  expect(pages[0]).toEqual({ kind: 'autoSummary' })
  expect(pages.length).toBeGreaterThan(1)
  expect(pages.slice(1).every((p) => p.kind === 'autoDetail')).toBe(true)
})

test('buildRuntimePages: custom デッキは pages のみ (auto detail 混在なし)', () => {
  const pages = buildRuntimePages(makeData([page('p1', [G2_LEVEL]), page('p2', [CLOCK_DT])]))
  expect(pages.length).toBe(2)
  expect(pages.every((p) => p.kind === 'custom')).toBe(true)
})

test('buildRuntimePages: 空ページ (描画 chip なし) はスキップ', () => {
  const pages = buildRuntimePages(
    makeData([page('p1', [G2_LEVEL]), page('p2', [`${BUILTIN_SOURCE_ID}|g2|ghost`])]),
  )
  expect(pages.length).toBe(1)
  expect(pages[0]).toMatchObject({ kind: 'custom', page: { id: 'p1' } })
})

test('buildRuntimePages: 全ページ空なら先頭 1 枚を fallback', () => {
  const pages = buildRuntimePages(makeData([page('p1', []), page('p2', [])]))
  expect(pages.length).toBe(1)
  expect(pages[0]).toMatchObject({ kind: 'custom', page: { id: 'p1' } })
})

test('buildRuntimePages: group が無い auto は summary 1 枚', () => {
  expect(buildRuntimePages(makeData(undefined, false))).toEqual([{ kind: 'autoSummary' }])
})

test('renderDeckPage: explicit 複数ページは最終行ドットバー (本文 9 行)', () => {
  const d = makeData([page('p1', [G2_LEVEL]), page('p2', [G2_LEVEL]), page('p3', [G2_LEVEL])])
  const built = buildRuntimePages(d)
  expect(built.length).toBe(3)
  const lines = renderDeckPage(built, 1, d).split('\n')
  expect(lines.length).toBe(MAX_ROWS) // 本文 9 行 + インジケータ 1 行
  const dots = (lines[MAX_ROWS - 1] ?? '').trim().split(' ')
  expect(dots).toEqual(['○', '●', '○']) // idx=1 が ●
})

test('renderDeckPage: 単一ページはインジケータ無し', () => {
  const d = makeData([page('p1', [G2_LEVEL])])
  const out = renderDeckPage(buildRuntimePages(d), 0, d)
  expect(out.includes('●') || out.includes('○')).toBe(false)
})

test('renderDeckPage: auto デッキ複数ページはインジケータ無し (回帰回避)', () => {
  const d = makeData()
  const built = buildRuntimePages(d)
  expect(built.length).toBeGreaterThan(1)
  const out = renderDeckPage(built, 0, d)
  expect(out.includes('●') || out.includes('○')).toBe(false)
})

test('renderDeckPage: 8 ページ超はテキスト i/N インジケータ', () => {
  const ps = Array.from({ length: 9 }, (_, i) => page(`p${i}`, [G2_LEVEL]))
  const d = makeData(ps)
  const last = renderDeckPage(buildRuntimePages(d), 2, d).split('\n')[MAX_ROWS - 1] ?? ''
  expect(last).toContain('3/9')
})

test('layoutLines: ページごとの customLabels が独立 (漏れない)', () => {
  const d = makeData()
  const labelKey = '@customLabel:lblA'
  const layA = { rows: emptyRows(), customLabels: { lblA: { text: 'HELLO-A' } } }
  layA.rows[0] = [labelKey]
  const layB = { rows: emptyRows(), customLabels: {} as Record<string, { text: string }> }
  layB.rows[0] = [labelKey]
  expect(layoutLines(layA, d, undefined, MAX_ROWS)[0]).toContain('HELLO-A')
  expect((layoutLines(layB, d, undefined, MAX_ROWS)[0] ?? '').includes('HELLO-A')).toBe(false)
})
