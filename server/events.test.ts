// events buffer の振る舞い (dedupe / rate / since cursor / reset / long-poll wake / TTL prune)。
// 実行: bun test server/events.test.ts
import { beforeEach, expect, test } from 'bun:test'
import type { EmitInput } from '../src/event-types.ts'
import { _resetForTest, emitEvent, pollEvents } from './events.ts'

function noti(id: string, ttlMs?: number): EmitInput {
  return { providerId: 'p', id, kind: 'notification', body: `body-${id}`, ttlMs }
}

beforeEach(() => _resetForTest())

test('emit して since=0 で取れる。cursor が増える', async () => {
  expect(emitEvent(noti('a'))).toEqual({ ok: true, seq: 1 })
  const r = await pollEvents(0, 0)
  expect(r.cursor).toBe(1)
  expect(r.reset).toBe(false)
  expect(r.events.map((e) => e.id)).toEqual(['a'])
})

test('同一 (providerId,id) の再 emit は duplicate', () => {
  expect(emitEvent(noti('a')).ok).toBe(true)
  expect(emitEvent(noti('a'))).toEqual({ ok: false, reason: 'duplicate' })
})

test('providerId 単位の rate limit', () => {
  for (let i = 0; i < 30; i++) expect(emitEvent(noti(`r${i}`)).ok).toBe(true)
  expect(emitEvent(noti('r30'))).toEqual({ ok: false, reason: 'rate' })
})

test('since=cursor は空 (reset なし)', async () => {
  emitEvent(noti('a'))
  const r = await pollEvents(1, 0)
  expect(r.events).toEqual([])
  expect(r.reset).toBe(false)
  expect(r.cursor).toBe(1)
})

test('since が先行 (server 再起動相当) なら reset:true で現在を返す', async () => {
  emitEvent(noti('a'))
  const r = await pollEvents(999, 0)
  expect(r.reset).toBe(true)
  expect(r.events.map((e) => e.id)).toEqual(['a'])
})

test('long-poll は emit で起きる', async () => {
  emitEvent(noti('a')) // seq 1
  const p = pollEvents(1, 2000)
  setTimeout(() => emitEvent(noti('b')), 30)
  const r = await p
  expect(r.events.map((e) => e.id)).toEqual(['b'])
})

test('long-poll は waitMs で空タイムアウトする', async () => {
  emitEvent(noti('a'))
  const r = await pollEvents(1, 50)
  expect(r.events).toEqual([])
})

test('TTL 切れイベントは prune される', async () => {
  emitEvent(noti('a', 10)) // 10ms で失効
  await new Promise((r) => setTimeout(r, 40))
  const r = await pollEvents(0, 0)
  expect(r.events).toEqual([])
  expect(r.cursor).toBe(1)
})
