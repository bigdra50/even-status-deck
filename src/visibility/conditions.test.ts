// computeVisibleMap の inPlace leaf 評価(#43)。inside で表示、outside で非表示、位置不明は fail-open。
// 実行: bun test src/visibility/conditions.test.ts
import { expect, test } from 'bun:test'
import { activeView, type Config, emptyConfig } from '../config'
import type { StatusDoc } from '../status-types'
import { computeVisibleMap } from './conditions'
import { segKey, type VisibilityLeaf } from './keys'

const SID = 'test.s'
const GID = 'g'
const KEY = segKey(SID, GID, 'seg')

// inPlace leaf を 1 つ持つ segment + その status を備えた最小 config を作る。
function setup(leaf: VisibilityLeaf): {
  cfg: Config
  statuses: Record<string, StatusDoc | null>
} {
  const cfg = emptyConfig()
  cfg.groups[SID] = {
    [GID]: { segments: [{ id: 'seg', visibility: { combinator: 'and', conditions: [leaf] } }] },
  }
  const view = activeView(cfg)
  view.groups[SID] = { [GID]: { enabled: true, segments: { seg: true } } }
  view.groupOrder = [{ sourceId: SID, groupId: GID }]
  const statuses: Record<string, StatusDoc | null> = {
    [SID]: {
      version: 1,
      ts: 0,
      groups: [{ id: GID, label: '', segments: [{ id: 'seg', label: '', value: 'x' }] }],
    },
  }
  return { cfg, statuses }
}

function vis(leaf: VisibilityLeaf, inside: Set<string> | null): boolean | undefined {
  const { cfg, statuses } = setup(leaf)
  return computeVisibleMap(cfg, statuses, new Map(), 0, inside).map.get(KEY)
}

test('inPlace(inside): 圏内で表示、圏外で非表示', () => {
  const leaf: VisibilityLeaf = { kind: 'inPlace', placeId: 'home' }
  expect(vis(leaf, new Set(['home']))).toBe(true) // home 圏内 → 表示
  expect(vis(leaf, new Set(['work']))).toBe(false) // 圏外 → 非表示
  expect(vis(leaf, new Set())).toBe(false) // どこにも居ない → 非表示
})

test('inPlace(outside): 圏外で表示、圏内で非表示', () => {
  const leaf: VisibilityLeaf = { kind: 'inPlace', placeId: 'home', outside: true }
  expect(vis(leaf, new Set(['home']))).toBe(false) // home 圏内 → 非表示(outside 反転)
  expect(vis(leaf, new Set())).toBe(true) // 圏外 → 表示
})

test('inPlace: 位置不明(null)は fail-open(常時表示)', () => {
  const leaf: VisibilityLeaf = { kind: 'inPlace', placeId: 'home' }
  expect(vis(leaf, null)).toBe(true) // na → combine で中立 → 表示
  expect(vis({ kind: 'inPlace', placeId: 'home', outside: true }, null)).toBe(true)
})
