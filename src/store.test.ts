// store (#88 Phase 4): builtin source 経由の subscribe/notify・health getter の回帰テスト。
// server source の fetch 経路は network mock が無いため対象外 (store-health.test.ts が
// その状態遷移ロジックを純粋関数として被覆する)。
// 実行: bun test src/store.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { BUILTIN_SOURCE_ID, type SourceDef } from './config'
import {
  getAllStatuses,
  getOnlineServerIds,
  getRenderableStatuses,
  getSourceHealth,
  getSourceStatus,
  pokeListeners,
  refreshBuiltins,
  setSources,
  subscribe,
} from './store'

const builtinDef: SourceDef = { id: BUILTIN_SOURCE_ID, kind: 'builtin', label: 'Local', urls: [] }

// 各テスト後に store を空にし、setSources の消去パスを通しつつ次テストへの汚染を防ぐ。
afterEach(() => {
  setSources([])
})

beforeEach(() => {
  setSources([])
})

test('setSources: builtin source を登録すると同期的に status が入る', () => {
  setSources([builtinDef])
  const status = getSourceStatus(BUILTIN_SOURCE_ID)
  expect(status).not.toBeNull()
  expect(status?.groups.some((g) => g.id === 'clock')).toBe(true)
})

test('getSourceHealth: builtin は常に online', () => {
  setSources([builtinDef])
  expect(getSourceHealth(BUILTIN_SOURCE_ID)).toBe('online')
})

test('getSourceHealth: 未登録 id は offline (status なし)', () => {
  expect(getSourceHealth('no-such-source')).toBe('offline')
})

test('getOnlineServerIds: builtin のみの場合は空集合 (server のみ対象)', () => {
  setSources([builtinDef])
  expect(getOnlineServerIds().size).toBe(0)
})

test('getAllStatuses / getRenderableStatuses: builtin の status をそのまま含む', () => {
  setSources([builtinDef])
  const all = getAllStatuses()
  const renderable = getRenderableStatuses()
  expect(all[BUILTIN_SOURCE_ID]).not.toBeNull()
  // builtin は health=online なので renderable でも除外されない。
  expect(renderable[BUILTIN_SOURCE_ID]).toEqual(all[BUILTIN_SOURCE_ID])
})

test('refreshBuiltins: builtin がある場合に notify される', () => {
  setSources([builtinDef])
  let calls = 0
  const unsub = subscribe(() => {
    calls++
  })
  refreshBuiltins()
  unsub()
  expect(calls).toBeGreaterThan(0)
})

test('refreshBuiltins: builtin が無い場合は notify されない (changed=false)', () => {
  setSources([])
  let calls = 0
  const unsub = subscribe(() => {
    calls++
  })
  refreshBuiltins()
  unsub()
  expect(calls).toBe(0)
})

test('subscribe/pokeListeners: 購読解除後は呼ばれない', () => {
  let calls = 0
  const unsub = subscribe(() => {
    calls++
  })
  pokeListeners()
  expect(calls).toBe(1)
  unsub()
  pokeListeners()
  expect(calls).toBe(1)
})

test('setSources: 消えた source の status は破棄される', () => {
  setSources([builtinDef])
  expect(getSourceStatus(BUILTIN_SOURCE_ID)).not.toBeNull()
  setSources([])
  expect(getSourceStatus(BUILTIN_SOURCE_ID)).toBeNull()
})
