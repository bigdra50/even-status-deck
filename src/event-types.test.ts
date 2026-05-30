// event-types の検証/サニタイズ (parseEmitInput / parseEventsDoc)。
// 実行: bun test src/event-types.test.ts
import { expect, test } from 'bun:test'
import { DEFAULT_EVENT_TTL_MS, parseEmitInput, parseEventsDoc } from './event-types'

test('notification: 最低1フィールドあれば通る・ttl 既定が入る', () => {
  const r = parseEmitInput({ providerId: 'p', id: '1', kind: 'notification', body: 'hi' })
  expect(r).toMatchObject({ providerId: 'p', id: '1', kind: 'notification', body: 'hi' })
  expect(r?.ttlMs).toBe(DEFAULT_EVENT_TTL_MS)
})

test('notification: app/sender/body すべて空なら破棄', () => {
  expect(parseEmitInput({ providerId: 'p', id: '1', kind: 'notification' })).toBeNull()
})

test('toast/banner: text 必須', () => {
  expect(parseEmitInput({ providerId: 'p', id: '1', kind: 'toast', text: 'ok' })?.text).toBe('ok')
  expect(parseEmitInput({ providerId: 'p', id: '1', kind: 'banner' })).toBeNull()
})

test('不正: kind 欠落 / providerId 空 は破棄', () => {
  expect(parseEmitInput({ providerId: 'p', id: '1' })).toBeNull()
  expect(parseEmitInput({ providerId: '', id: '1', kind: 'toast', text: 'x' })).toBeNull()
})

test('clamp: durationMs/ttlMs は範囲内に丸める', () => {
  const r = parseEmitInput({
    providerId: 'p',
    id: '1',
    kind: 'toast',
    text: 'x',
    durationMs: 9_999_999,
    ttlMs: -5,
  })
  expect(r?.durationMs).toBe(60_000)
  expect(r?.ttlMs).toBe(0)
})

test('clip: 長い body は上限で切る', () => {
  const long = 'あ'.repeat(1000)
  const r = parseEmitInput({ providerId: 'p', id: '1', kind: 'notification', body: long })
  expect(r?.body?.length).toBe(256)
})

test('parseEventsDoc: 不正イベントを除外し seq 付きを通す', () => {
  const doc = parseEventsDoc({
    version: 1,
    cursor: 3,
    reset: false,
    events: [
      { seq: 1, ts: 100, providerId: 'p', id: 'a', kind: 'toast', text: 'ok' },
      { providerId: 'p', id: 'b', kind: 'toast', text: 'no-seq' }, // seq 無し → 除外
      { seq: 2, providerId: 'p', id: 'c', kind: 'bogus', text: 'x' }, // 不正 kind → 除外
    ],
  })
  expect(doc?.cursor).toBe(3)
  expect(doc?.events.map((e) => e.id)).toEqual(['a'])
})

test('parseEventsDoc: version/cursor が数値でなければ null', () => {
  expect(parseEventsDoc({ cursor: 1, events: [] })).toBeNull()
  expect(parseEventsDoc({ version: 1, events: [] })).toBeNull()
})
