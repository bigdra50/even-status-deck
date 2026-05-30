// dialog 相関ストア (createDialogRequest / completeDialogRequest / pollDialogResult)。
// 実行: bun test server/actions.test.ts
import { beforeEach, expect, test } from 'bun:test'
import {
  _resetForTest,
  completeDialogRequest,
  createDialogRequest,
  pollDialogResult,
} from './actions.ts'

beforeEach(() => _resetForTest())

test('createDialogRequest は act_ 接頭の requestId を払い出す', () => {
  const id = createDialogRequest('p', ['はい', 'いいえ'])
  expect(id).toMatch(/^act_[0-9a-f]+$/)
})

test('回答前は pending', async () => {
  const id = createDialogRequest('p', ['はい', 'いいえ'])
  const r = await pollDialogResult(id, 0)
  expect(r).toEqual({ status: 'pending', result: undefined })
})

test('complete → poll で completed と result', async () => {
  const id = createDialogRequest('p', ['はい', 'いいえ'])
  expect(completeDialogRequest(id, 1, 'いいえ')).toEqual({ ok: true })
  const r = await pollDialogResult(id, 0)
  expect(r?.status).toBe('completed')
  expect(r?.result).toMatchObject({ index: 1, action: 'いいえ' })
})

test('action ラベル不一致は拒否', () => {
  const id = createDialogRequest('p', ['はい', 'いいえ'])
  expect(completeDialogRequest(id, 0, 'いいえ')).toEqual({ ok: false, reason: 'action_mismatch' })
})

test('範囲外 index は拒否', () => {
  const id = createDialogRequest('p', ['はい', 'いいえ'])
  expect(completeDialogRequest(id, 5)).toEqual({ ok: false, reason: 'bad_index' })
})

test('未知 requestId は not_found', () => {
  expect(completeDialogRequest('act_nope', 0)).toEqual({ ok: false, reason: 'not_found' })
})

test('二重回答は already_completed', () => {
  const id = createDialogRequest('p', ['はい', 'いいえ'])
  expect(completeDialogRequest(id, 0).ok).toBe(true)
  expect(completeDialogRequest(id, 1)).toEqual({ ok: false, reason: 'already_completed' })
})

test('TTL 切れは expired になり回答も拒否', async () => {
  const id = createDialogRequest('p', ['はい', 'いいえ'], 1_000) // 最小 ttl 1000ms
  // 期限まで poll で待つ → expired
  const r = await pollDialogResult(id, 5_000)
  expect(r?.status).toBe('expired')
  expect(completeDialogRequest(id, 0)).toEqual({ ok: false, reason: 'expired' })
})

test('long-poll は complete で起きる', async () => {
  const id = createDialogRequest('p', ['はい', 'いいえ'])
  const pending = pollDialogResult(id, 3_000)
  setTimeout(() => completeDialogRequest(id, 0, 'はい'), 30)
  const r = await pending
  expect(r?.status).toBe('completed')
  expect(r?.result?.index).toBe(0)
})
