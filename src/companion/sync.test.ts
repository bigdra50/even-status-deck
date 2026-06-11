// sync.ts の純関数 (parseKey) と、store 連携の薄い関数 (worstReportedState) のテスト。
// worstReportedState は statuses map (store.ts) を経由するため、setSources で builtin/server
// の最小状態を作って検証する (store.test.ts の setSources 利用パターンを踏襲)。
// 実行: bun test src/companion/sync.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { addServer, BUILTIN_SOURCE_ID, emptyConfig } from '../config'
import { setSources } from '../store'
import { ctx } from './state'
import { parseKey, worstReportedState } from './sync'

beforeEach(() => {
  ctx.config = emptyConfig()
  setSources(ctx.config.sources)
})

afterEach(() => {
  setSources([])
})

test('parseKey: "sourceId|groupId" を GroupRef に分解する', () => {
  expect(parseKey(`${BUILTIN_SOURCE_ID}|clock`)).toEqual({
    sourceId: BUILTIN_SOURCE_ID,
    groupId: 'clock',
  })
})

test('parseKey: segKey ("sourceId|groupId|segId") も groupId までで分解する', () => {
  // parseKey は GroupRef ({sourceId, groupId}) を返す。3 要素目 (segId) は無視される。
  expect(parseKey(`${BUILTIN_SOURCE_ID}|g2|level`)).toEqual({
    sourceId: BUILTIN_SOURCE_ID,
    groupId: 'g2',
  })
})

test('parseKey: 不正な key (区切り無し) は groupId が空文字になる', () => {
  expect(parseKey('nosep')).toEqual({ sourceId: 'nosep', groupId: '' })
})

test('worstReportedState: builtin の通常状態は ok (group/segment に state 異常無し)', () => {
  expect(worstReportedState(BUILTIN_SOURCE_ID)).toEqual({ state: 'ok', message: undefined })
})

test('worstReportedState: status 未取得の server source は ok (doc=null → 既定値)', () => {
  const server = addServer(ctx.config, 'My Mac', 'http://127.0.0.1:8723')
  setSources(ctx.config.sources)
  expect(worstReportedState(server.id)).toEqual({ state: 'ok', message: undefined })
})
