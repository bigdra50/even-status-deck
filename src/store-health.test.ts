// store-health (#88 Phase 4): health 状態遷移・backoff・notify 抑制・signature の純粋関数テスト。
// 実行: bun test src/store-health.test.ts
import { expect, test } from 'bun:test'
import type { StatusDoc } from './status-types'
import {
  healthFromFailCount,
  RETRY_BACKOFF_MS,
  RETRY_MAX,
  retryDelayMs,
  shouldNotifyOnFailure,
  shouldNotifyOnSuccess,
  statusSig,
} from './store-health'

function doc(groups: StatusDoc['groups']): StatusDoc {
  return { version: 1, ts: 0, groups }
}

// ── healthFromFailCount: online -> stale -> offline の遷移 ──

test('healthFromFailCount: failCount=0 かつ status あり -> online', () => {
  expect(healthFromFailCount(0, true)).toBe('online')
})

test('healthFromFailCount: failCount=0 かつ status なし -> offline (未成功)', () => {
  expect(healthFromFailCount(0, false)).toBe('offline')
})

test('healthFromFailCount: 1 回目の失敗 (n=1) で online -> stale', () => {
  expect(healthFromFailCount(1, true)).toBe('stale')
})

test('healthFromFailCount: n=RETRY_MAX までは stale (retry 継続中)', () => {
  expect(healthFromFailCount(RETRY_MAX, true)).toBe('stale')
})

test('healthFromFailCount: n=RETRY_MAX+1 で stale -> offline (retry 尽きた)', () => {
  expect(healthFromFailCount(RETRY_MAX + 1, true)).toBe('offline')
})

// ── retryDelayMs: backoff schedule ──

test('retryDelayMs: n=1..RETRY_MAX は RETRY_BACKOFF_MS をそのまま返す', () => {
  for (let n = 1; n <= RETRY_MAX; n++) {
    expect(retryDelayMs(n)).toBe(RETRY_BACKOFF_MS[n - 1])
  }
})

test('retryDelayMs: n=0 (失敗していない) は undefined', () => {
  expect(retryDelayMs(0)).toBeUndefined()
})

test('retryDelayMs: n=RETRY_MAX+1 (offline 確定後) は undefined (retry を仕込まない)', () => {
  expect(retryDelayMs(RETRY_MAX + 1)).toBeUndefined()
})

// ── shouldNotifyOnFailure: 遷移点 (n=1 / n=RETRY_MAX+1) のみ true ──

test('shouldNotifyOnFailure: n=1 (online->stale) は true', () => {
  expect(shouldNotifyOnFailure(1)).toBe(true)
})

test('shouldNotifyOnFailure: n=RETRY_MAX+1 (stale->offline) は true', () => {
  expect(shouldNotifyOnFailure(RETRY_MAX + 1)).toBe(true)
})

test('shouldNotifyOnFailure: 中間 retry 失敗 (n=2..RETRY_MAX) は false', () => {
  for (let n = 2; n <= RETRY_MAX; n++) {
    expect(shouldNotifyOnFailure(n)).toBe(false)
  }
})

test('shouldNotifyOnFailure: offline 確定後の継続失敗 (n>RETRY_MAX+1) は false', () => {
  expect(shouldNotifyOnFailure(RETRY_MAX + 2)).toBe(false)
})

// ── shouldNotifyOnSuccess ──

test('shouldNotifyOnSuccess: sig 変化のみで true', () => {
  expect(shouldNotifyOnSuccess(true, false)).toBe(true)
})

test('shouldNotifyOnSuccess: unhealthy からの復帰のみで true', () => {
  expect(shouldNotifyOnSuccess(false, true)).toBe(true)
})

test('shouldNotifyOnSuccess: sig 不変 かつ healthy 維持 (定常 poll) は false', () => {
  expect(shouldNotifyOnSuccess(false, false)).toBe(false)
})

// ── statusSig: 内容シグネチャの安定性 ──

test('statusSig: 同一内容 + 異なる ts は同じ sig (ts は除外)', () => {
  const a: StatusDoc = {
    version: 1,
    ts: 1000,
    groups: [{ id: 'g2', label: '', segments: [{ id: 'level', label: '', value: '80%' }] }],
  }
  const b: StatusDoc = { ...a, ts: 9999 }
  expect(statusSig(a)).toBe(statusSig(b))
})

test('statusSig: segment value が変わると sig も変わる', () => {
  const a = doc([{ id: 'g2', label: '', segments: [{ id: 'level', label: '', value: '80%' }] }])
  const b = doc([{ id: 'g2', label: '', segments: [{ id: 'level', label: '', value: '79%' }] }])
  expect(statusSig(a)).not.toBe(statusSig(b))
})

test('statusSig: group/segment の state 変化 (値据え置き) でも sig が変わる (PROTOCOL §3)', () => {
  const a = doc([
    { id: 'g2', label: '', segments: [{ id: 'level', label: '', value: '80%', state: 'ok' }] },
  ])
  const b = doc([
    { id: 'g2', label: '', segments: [{ id: 'level', label: '', value: '80%', state: 'stale' }] },
  ])
  expect(statusSig(a)).not.toBe(statusSig(b))
})
