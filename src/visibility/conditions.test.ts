// computeVisibleMap の peer 条件・truthMap・display 排他の評価。
// 実行: bun test src/visibility/conditions.test.ts
import { expect, test } from 'bun:test'
import { activeView, type Config, emptyConfig } from '../config'
import type { Segment, StatusDoc } from '../status-types'
import { computeVisibleMap } from './conditions'
import { segKey, type VisibilityCond } from './keys'

const SID = 'test.s'
const GID = 'g'

// ── peer 条件 (同 group 内の別 segment を参照) ──
// host(hostId) に cond を付け、group に liveSegs を持つ最小 config を作る。
function setupMulti(
  hostId: string,
  cond: VisibilityCond,
  liveSegs: Segment[],
): { cfg: Config; statuses: Record<string, StatusDoc | null> } {
  const cfg = emptyConfig()
  cfg.groups[SID] = {
    [GID]: {
      segments: liveSegs.map((s) =>
        s.id === hostId ? { id: s.id, visibility: cond } : { id: s.id },
      ),
    },
  }
  const view = activeView(cfg)
  view.groups[SID] = {
    [GID]: { enabled: true, segments: Object.fromEntries(liveSegs.map((s) => [s.id, true])) },
  }
  view.groupOrder = [{ sourceId: SID, groupId: GID }]
  const statuses: Record<string, StatusDoc | null> = {
    [SID]: { version: 1, ts: 0, groups: [{ id: GID, label: '', segments: liveSegs }] },
  }
  return { cfg, statuses }
}
function visOf(
  hostId: string,
  cond: VisibilityCond,
  liveSegs: Segment[],
  prev = new Map(),
  now = 0,
): { v: boolean | undefined; wakeAt: number | null; stateKeys: string[] } {
  const { cfg, statuses } = setupMulti(hostId, cond, liveSegs)
  const r = computeVisibleMap(cfg, statuses, prev, now)
  return {
    v: r.map.get(segKey(SID, GID, hostId)),
    wakeAt: r.wakeAt,
    stateKeys: [...r.states.keys()],
  }
}
const seg = (id: string, value: string, percent?: number): Segment =>
  percent === undefined ? { id, label: '', value } : { id, label: '', value, percent }

test('threshold peer: 兄弟 level の percent しきい値で host を制御', () => {
  const cond: VisibilityCond = {
    combinator: 'and',
    conditions: [{ kind: 'threshold', op: 'lte', value: 20, seg: 'level' }],
  }
  expect(visOf('eta', cond, [seg('level', '15%', 15), seg('eta', '2h')]).v).toBe(true) // ≤20 → 表示
  expect(visOf('eta', cond, [seg('level', '80%', 80), seg('eta', '2h')]).v).toBe(false) // >20 → 非表示
})

test('threshold peer 不在は false (fail-open しない)', () => {
  const cond: VisibilityCond = {
    combinator: 'and',
    conditions: [{ kind: 'threshold', op: 'lte', value: 20, seg: 'level' }],
  }
  // live に level が無い → peer 不在 → false (na にすると単独条件で常時表示になり誤り)
  expect(visOf('eta', cond, [seg('eta', '2h')]).v).toBe(false)
})

test('threshold peer ありで percent 欠落は na (fail-open)', () => {
  const cond: VisibilityCond = {
    combinator: 'and',
    conditions: [{ kind: 'threshold', op: 'lte', value: 20, seg: 'rate' }],
  }
  // rate は存在するが percent 無し → na → 単独で fail-open → 表示
  expect(visOf('eta', cond, [seg('rate', '12%/h'), seg('eta', '2h')]).v).toBe(true)
})

test('present: 兄弟が値を持つとき表示、空で非表示、absent で反転', () => {
  const has: VisibilityCond = { combinator: 'and', conditions: [{ kind: 'present', seg: 'rate' }] }
  expect(visOf('eta', has, [seg('rate', '12%/h'), seg('eta', '2h')]).v).toBe(true)
  expect(visOf('eta', has, [seg('rate', ''), seg('eta', '2h')]).v).toBe(false) // 空 → 非表示
  expect(visOf('eta', has, [seg('eta', '2h')]).v).toBe(false) // 不在 → 非表示
  const absent: VisibilityCond = {
    combinator: 'and',
    conditions: [{ kind: 'present', seg: 'rate', absent: true }],
  }
  expect(visOf('eta', absent, [seg('rate', ''), seg('eta', '2h')]).v).toBe(true) // 空 + absent → 表示
})

test('onChange peer: 兄弟の変化後 holdMs 表示、状態キーに対象 id を含む', () => {
  const cond: VisibilityCond = {
    combinator: 'and',
    conditions: [{ kind: 'onChange', holdMs: 5000, seg: 'level' }],
  }
  // 初回観測 (prev 無し) → activeUntil=0 → 非表示 (フラッシュ防止)
  const first = visOf('eta', cond, [seg('level', '80%', 80), seg('eta', '2h')], new Map(), 1000)
  expect(first.v).toBe(false)
  expect(first.stateKeys.some((k) => k.endsWith(':level'))).toBe(true) // 対象 id がキーに入る
  // level 変化 → holdMs 表示、wakeAt=now+holdMs
  const prev = computeVisibleMap(
    setupMulti('eta', cond, [seg('level', '80%', 80), seg('eta', '2h')]).cfg,
    setupMulti('eta', cond, [seg('level', '80%', 80), seg('eta', '2h')]).statuses,
    new Map(),
    1000,
  ).states
  const after = visOf('eta', cond, [seg('level', '79%', 79), seg('eta', '2h')], prev, 2000)
  expect(after.v).toBe(true)
  expect(after.wakeAt).toBe(7000)
})

test('self threshold (seg 省略) は従来どおり自身の percent を見る', () => {
  const cond: VisibilityCond = {
    combinator: 'and',
    conditions: [{ kind: 'threshold', op: 'lte', value: 20 }],
  }
  expect(visOf('level', cond, [seg('level', '10%', 10)]).v).toBe(true)
  expect(visOf('level', cond, [seg('level', '90%', 90)]).v).toBe(false)
})

// ── truthMap (発火用 strict tri-state) と display 排他 ──
function truthOf(hostId: string, cond: VisibilityCond, liveSegs: Segment[]) {
  const { cfg, statuses } = setupMulti(hostId, cond, liveSegs)
  const r = computeVisibleMap(cfg, statuses, new Map(), 0)
  return {
    truth: r.truthMap.get(segKey(SID, GID, hostId)),
    inline: r.map.get(segKey(SID, GID, hostId)),
  }
}

test('truthMap: threshold は確定 true/false、percent 欠落は unknown (fail-open しない)', () => {
  const c: VisibilityCond = {
    combinator: 'and',
    conditions: [{ kind: 'threshold', op: 'lte', value: 20 }],
  }
  expect(truthOf('level', c, [seg('level', '10%', 10)]).truth).toBe(true)
  expect(truthOf('level', c, [seg('level', '90%', 90)]).truth).toBe(false)
  expect(truthOf('level', c, [seg('level', 'n/a')]).truth).toBe('unknown') // percent 無し=unknown(発火しない)
})

test('truthMap: AND は false 優先、OR は true 優先、残り unknown', () => {
  // level percent欠落(unknown) と present(rate 値あり=true) の複合
  const live = [seg('eta', '2h'), seg('rate', '12%/h'), seg('level', 'n/a')]
  const andC: VisibilityCond = {
    combinator: 'and',
    conditions: [
      { kind: 'threshold', op: 'lte', value: 20, seg: 'level' },
      { kind: 'present', seg: 'rate' },
    ],
  }
  // and: present=true, threshold=unknown → false なし・unknown あり → unknown
  expect(truthOf('eta', andC, live).truth).toBe('unknown')
  const orC: VisibilityCond = { ...andC, combinator: 'or' }
  // or: present=true → true 優先
  expect(truthOf('eta', orC, live).truth).toBe(true)
})

test('inline 排他: display 指定 segment は inline map=false (truthMap には truth が残る)', () => {
  const c: VisibilityCond = {
    combinator: 'and',
    conditions: [{ kind: 'threshold', op: 'lte', value: 20 }],
    display: { ui: 'toast' },
  }
  const r = truthOf('level', c, [seg('level', '10%', 10)])
  expect(r.truth).toBe(true) // 発火判定は true
  expect(r.inline).toBe(false) // inline は出さない (排他)
})
