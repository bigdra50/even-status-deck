// 条件成立 → overlay UI 提示ランタイム (display.ts) のテスト。
// edge(toast/notification/dialog) と level(banner) の発火・seed・cooldown・unknown 温存・banner 競合/dismiss。
// 実行: bun test src/visibility/display.test.ts
import { expect, test } from 'bun:test'
import { activeView, BUILTIN_SOURCE_ID, type Config, emptyConfig } from '../config'
import { createConditionDisplayRuntime } from './display'
import { type ConditionTruth, type ConditionTruthMap, type DisplayUi, segKey } from './keys'

const B = BUILTIN_SOURCE_ID
const GID = 'g'

// display 指定 segment を持つ最小 config。条件内容は runtime が見ない (truthMap で truth を渡す) ので任意。
function cfg(segs: { id: string; ui: DisplayUi; text?: string }[]): Config {
  const c = emptyConfig()
  c.groups[B] = {
    [GID]: {
      segments: segs.map((s) => ({
        id: s.id,
        visibility: {
          combinator: 'and' as const,
          conditions: [{ kind: 'present' as const, seg: 'x' }],
          display: s.text ? { ui: s.ui, text: s.text } : { ui: s.ui },
        },
      })),
    },
  }
  const view = activeView(c)
  view.groups[B] = {
    [GID]: { enabled: true, segments: Object.fromEntries(segs.map((s) => [s.id, true])) },
  }
  view.groupOrder = [{ sourceId: B, groupId: GID }]
  return c
}

function tm(entries: Record<string, ConditionTruth>): ConditionTruthMap {
  const m: ConditionTruthMap = new Map()
  for (const [id, t] of Object.entries(entries)) m.set(segKey(B, GID, id), t)
  return m
}

test('edge: known-false → known-true で 1 回発火 (toast)', () => {
  const c = cfg([{ id: 'a', ui: 'toast' }])
  const rt = createConditionDisplayRuntime()
  expect(rt.seed(c, tm({ a: false })).fires).toEqual([]) // seed は発火しない
  const r = rt.observe(c, tm({ a: true }), 1000)
  expect(r.fires.length).toBe(1)
  expect(r.fires[0]?.ui).toBe('toast')
  expect(r.fires[0]?.segId).toBe('a')
})

test('edge: 未観測(seed なし)で初回 true は発火しない = strict arm (storm 防止の意図的トレードオフ)', () => {
  // 起動/接続直後に既に true だった条件は arm のみ。跨いだ瞬間でないので撃たない。
  // (一度 false を観測してから true で発火する。cold-start storm を避けるための設計判断)
  const c = cfg([{ id: 'a', ui: 'toast' }])
  const rt = createConditionDisplayRuntime()
  expect(rt.observe(c, tm({ a: true }), 0).fires).toEqual([]) // seed 無し・初回 true → arm のみ
  expect(rt.observe(c, tm({ a: false }), 1000).fires).toEqual([]) // false 観測 (re-arm 基準)
  expect(rt.observe(c, tm({ a: true }), 2000).fires.length).toBe(1) // false → true で発火
})

test('edge: seed が known-true でも observe で発火しない (起動時ストーム防止)', () => {
  const c = cfg([{ id: 'a', ui: 'toast' }])
  const rt = createConditionDisplayRuntime()
  expect(rt.seed(c, tm({ a: true })).fires).toEqual([])
  expect(rt.observe(c, tm({ a: true }), 1000).fires).toEqual([]) // 既に true → 立ち上がりでない
})

test('edge: true 継続では再発火しない', () => {
  const c = cfg([{ id: 'a', ui: 'toast' }])
  const rt = createConditionDisplayRuntime()
  rt.seed(c, tm({ a: false }))
  expect(rt.observe(c, tm({ a: true }), 0).fires.length).toBe(1)
  expect(rt.observe(c, tm({ a: true }), 1000).fires).toEqual([])
})

test('edge: cooldown 中の再立ち上がりは抑止、cooldown 経過後は発火', () => {
  const c = cfg([{ id: 'a', ui: 'notification' }])
  const rt = createConditionDisplayRuntime()
  rt.seed(c, tm({ a: false }))
  expect(rt.observe(c, tm({ a: true }), 0).fires.length).toBe(1) // 発火 (lastFired=0)
  rt.observe(c, tm({ a: false }), 5000) // re-arm
  expect(rt.observe(c, tm({ a: true }), 10_000).fires).toEqual([]) // cooldown(30s)内 → 抑止
  rt.observe(c, tm({ a: false }), 40_000) // re-arm
  expect(rt.observe(c, tm({ a: true }), 41_000).fires.length).toBe(1) // 経過後 → 発火
})

test('edge: unknown は edge を再アームせず前回 known 値を温存する', () => {
  const c = cfg([{ id: 'a', ui: 'toast' }])
  const rt = createConditionDisplayRuntime()
  rt.seed(c, tm({ a: false }))
  expect(rt.observe(c, tm({ a: 'unknown' }), 1000).fires).toEqual([]) // unknown → 発火せず温存
  expect(rt.observe(c, tm({ a: true }), 2000).fires.length).toBe(1) // 温存 false → true で発火
})

test('edge: offline(key 欠落)→再接続 true で誤再発火しない (前回 true を温存)', () => {
  const c = cfg([{ id: 'a', ui: 'toast' }])
  const rt = createConditionDisplayRuntime()
  rt.seed(c, tm({ a: true })) // 既に true
  expect(rt.observe(c, tm({}), 1000).fires).toEqual([]) // offline = key 欠落 = unknown
  expect(rt.observe(c, tm({ a: true }), 2000).fires).toEqual([]) // 再接続 true: 立ち上がりでない → 発火せず
})

test('edge: unknown(na fail-open相当) では発火しない', () => {
  const c = cfg([{ id: 'a', ui: 'dialog' }])
  const rt = createConditionDisplayRuntime()
  rt.seed(c, tm({ a: 'unknown' }))
  expect(rt.observe(c, tm({ a: 'unknown' }), 1000).fires).toEqual([])
})

test('banner: seed で known-true なら set、解消で clear', () => {
  const c = cfg([{ id: 'a', ui: 'banner' }])
  const rt = createConditionDisplayRuntime()
  expect(rt.seed(c, tm({ a: true })).banner).toMatchObject({ kind: 'set', segId: 'a' })
  expect(rt.observe(c, tm({ a: false }), 1000).banner).toEqual({ kind: 'clear' })
})

test('banner: 条件 banner が無ければ none (server banner を温存)', () => {
  const c = cfg([{ id: 'a', ui: 'banner' }])
  const rt = createConditionDisplayRuntime()
  expect(rt.observe(c, tm({ a: false }), 0).banner).toEqual({ kind: 'none' })
})

test('banner: 競合は active view 順で先勝ち', () => {
  const c = cfg([
    { id: 'a', ui: 'banner' },
    { id: 'b', ui: 'banner' },
  ])
  const rt = createConditionDisplayRuntime()
  const r = rt.observe(c, tm({ a: true, b: true }), 0)
  expect(r.banner).toMatchObject({ kind: 'set', segId: 'a' }) // meta 順先頭
})

test('banner: dismiss は known-false まで抑止し、false 後に再アーム', () => {
  const c = cfg([{ id: 'a', ui: 'banner' }])
  const rt = createConditionDisplayRuntime()
  expect(rt.observe(c, tm({ a: true }), 0).banner).toMatchObject({ kind: 'set', segId: 'a' })
  rt.dismissBanner() // tap で消した
  expect(rt.observe(c, tm({ a: true }), 1000).banner).toEqual({ kind: 'clear' }) // 抑止中
  expect(rt.observe(c, tm({ a: false }), 2000).banner).toEqual({ kind: 'none' }) // false → 再アーム(占有解放済)
  expect(rt.observe(c, tm({ a: true }), 3000).banner).toMatchObject({ kind: 'set', segId: 'a' }) // 再表示
})

test('custom text は fire に載る', () => {
  const c = cfg([{ id: 'a', ui: 'toast', text: 'Battery low!' }])
  const rt = createConditionDisplayRuntime()
  rt.seed(c, tm({ a: false }))
  expect(rt.observe(c, tm({ a: true }), 0).fires[0]?.text).toBe('Battery low!')
})

test('disabled segment は対象外 (発火しない)', () => {
  const c = cfg([{ id: 'a', ui: 'toast' }])
  activeView(c).groups[B][GID].segments.a = false // 無効化
  const rt = createConditionDisplayRuntime()
  rt.seed(c, tm({ a: false }))
  expect(rt.observe(c, tm({ a: true }), 0).fires).toEqual([])
})
