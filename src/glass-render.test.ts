// glass マルチページ (RuntimePage) 描画ロジックの回帰テスト。
// 実行: bun test src/glass-render.test.ts
import { expect, test } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import {
  activeView,
  addServer,
  BUILTIN_SOURCE_ID,
  type Config,
  emptyConfig,
  type GlassPage,
  syncSourceWithStatus,
} from './config'
import {
  buildRuntimePages,
  GLASS_PADDING,
  GLASS_WIDTH,
  type GlassData,
  layoutLines,
  MAX_ROWS,
  renderDeckPage,
  summarySections,
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

test('renderDeckPage: explicit 複数ページもインジケータ無し (本文 10 行・撤去後)', () => {
  const d = makeData([page('p1', [G2_LEVEL]), page('p2', [G2_LEVEL]), page('p3', [G2_LEVEL])])
  const built = buildRuntimePages(d)
  expect(built.length).toBe(3)
  const out = renderDeckPage(built, 1, d)
  expect(out.includes('●') || out.includes('○')).toBe(false)
  expect(out.split('\n').length).toBeLessThanOrEqual(MAX_ROWS)
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

// ── group 見出しマージ (merge unit) ──

// builtin 'claude-code' 相当 + 外部 provider 'claude-limits' 相当が両方 label 'Claude' の StatusDoc。
function claudeDoc(extraSegs = 0): StatusDoc {
  const extra = Array.from({ length: extraSegs }, (_, i) => ({
    id: `x${i}`,
    label: `Metric${i}`,
    value: '12345%',
  }))
  return {
    version: 1,
    ts: 0,
    groups: [
      {
        id: 'claude-code',
        label: 'Claude',
        segments: [{ id: 'cost', label: 'Cost', value: '$12' }],
      },
      {
        id: 'claude-limits',
        label: 'Claude',
        segments: [{ id: 'session', label: '5h', value: '42%' }, ...extra],
      },
      { id: 'system', label: 'System', segments: [{ id: 'cpu', label: 'CPU', value: '8%' }] },
    ],
  }
}

// server source 1 つを sync 済みにした GlassData (builtin は status 無し = 非描画)。
function makeServerData(extraSegs = 0): { d: GlassData; sid: string } {
  const config: Config = emptyConfig()
  const src = addServer(config, 'Mac')
  const doc = claudeDoc(extraSegs)
  syncSourceWithStatus(config, src.id, doc) // 素材 + lastLabel (merge identity) を捕捉
  return { d: { config, statuses: { [src.id]: doc } }, sid: src.id }
}

test('summarySections: 同 source 同見出し group は 1 行にマージ (見出し 1 回)', () => {
  const { d } = makeServerData()
  const { top, bottom } = summarySections(d)
  expect(top).toEqual(['Claude  Cost $12  5h 42%', 'System  CPU 8%'])
  expect(bottom).toEqual([])
})

test('summarySections: member の片方が offline でも unit は崩れない', () => {
  const { d, sid } = makeServerData()
  // claude-limits だけ status から消す (offline 相当)
  const doc = d.statuses[sid]
  if (doc) doc.groups = doc.groups.filter((g) => g.id !== 'claude-limits')
  const { top } = summarySections(d)
  expect(top[0]).toBe('Claude  Cost $12') // 見出し・位置は不変、segment が減るだけ
})

test('summarySections: 長い summary は物理 1 行に clamp して "… +N" を付ける', () => {
  const { d } = makeServerData(12) // claude-limits に 12 segment 追加 → 確実に 560px 超え
  const { top } = summarySections(d)
  const line = top[0] ?? ''
  expect(line).toMatch(/… \+\d+$/)
  expect(getTextWidth(line)).toBeLessThanOrEqual(GLASS_WIDTH - 2 * GLASS_PADDING)
})

test('summarySections: 先頭 segment 単独で幅超過しても物理 1 行 (px 切り詰め)', () => {
  const { d, sid } = makeServerData(3)
  const doc = d.statuses[sid]
  const cost = doc?.groups.find((g) => g.id === 'claude-code')?.segments[0]
  if (cost) cost.value = 'x'.repeat(400) // 病的な劣化値 (1 part で 560px 超)
  const { top } = summarySections(d)
  const line = top[0] ?? ''
  expect(getTextWidth(line)).toBeLessThanOrEqual(GLASS_WIDTH - 2 * GLASS_PADDING)
  expect(line).toMatch(/…/) // 切り詰め + '… +N' が付く
})

test('layoutLines: 空見出しの別 group 同士は dedup されない (merge identity ベース)', () => {
  // 見出し無し (label='') の server group 2 つ: groupLabelText は source label にフォールバックして
  // 両方 'Mac' を出すが、merge unit は別物なので 2 つ目のラベルを抑止しない。
  const config: Config = emptyConfig()
  const src = addServer(config, 'Mac')
  const doc: StatusDoc = {
    version: 1,
    ts: 0,
    groups: [
      { id: 'alpha', label: '', segments: [{ id: 'a', label: 'A', value: '1' }] },
      { id: 'beta', label: '', segments: [{ id: 'b', label: 'B', value: '2' }] },
    ],
  }
  syncSourceWithStatus(config, src.id, doc)
  const d: GlassData = { config, statuses: { [src.id]: doc } }
  const lay = { rows: emptyRows(), customLabels: {} as Record<string, { text: string }> }
  lay.rows[0] = [`${src.id}|alpha|a`, `${src.id}|beta|b`]
  expect(layoutLines(lay, d, undefined, MAX_ROWS)[0]).toBe('Mac A 1  Mac B 2')
})

test('renderDeckPage: bottom 配置の merged 行でも本文は MAX_ROWS に収まる', () => {
  const { d, sid } = makeServerData(12)
  const vg = activeView(d.config).groups[sid]?.['claude-code']
  if (vg) vg.align = 'bottom' // 代表の align に従い unit ごと bottom へ
  const out = renderDeckPage(buildRuntimePages(d), 0, d)
  const rows = out.split('\n')
  expect(rows.length).toBeLessThanOrEqual(MAX_ROWS)
  expect(rows[rows.length - 1]).toMatch(/^Claude {2}/) // merged 行が最下段
  expect(rows.filter((r) => r.startsWith('Claude')).length).toBe(1)
})

test('buildRuntimePages/renderDeckPage: merged unit の detail は 1 ページに全 member', () => {
  const { d } = makeServerData()
  const pages = buildRuntimePages(d)
  // summary + Claude(merged) + System の 3 ページ
  expect(pages.length).toBe(3)
  const detail = renderDeckPage(pages, 1, d)
  expect(detail.split('\n')[0]).toBe('Claude') // 見出し 1 回
  expect(detail).toContain('Cost')
  expect(detail).toContain('5h')
  expect(detail.match(/Claude/g)?.length).toBe(1)
})

test('layoutLines: 隣接する同見出し member は group ラベルを 1 回だけ前置 (label OFF が run を汚さない)', () => {
  const { d, sid } = makeServerData()
  const lay = { rows: emptyRows(), customLabels: {} as Record<string, { text: string }> }
  lay.rows[0] = [`${sid}|claude-code|cost`, `${sid}|claude-limits|session`]
  const line = layoutLines(lay, d, undefined, MAX_ROWS)[0] ?? ''
  expect(line).toBe('Claude Cost $12  5h 42%') // 見出しは先頭 1 回
  // 先頭 member の default-label を OFF → 2 番目の member が見出しを出す (poisoning 回帰防止)
  const vg = activeView(d.config).groups[sid]?.['claude-code']
  if (vg) vg.showDefaultLabel = false
  const line2 = layoutLines(lay, d, undefined, MAX_ROWS)[0] ?? ''
  expect(line2).toBe('Cost $12  Claude 5h 42%')
})
