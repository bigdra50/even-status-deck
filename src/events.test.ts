// since (cursor) の reload 跨ぎ永続化ヘルパー (loadSince / saveSince)。
// 実行: bun test src/events.test.ts
import { expect, test } from 'bun:test'
import { loadSince, saveSince } from './events'

// localStorage 互換の最小モック。
type Mock = {
  store: Map<string, string>
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
}

function mockStorage(init?: Record<string, string>): Mock {
  const store = new Map<string, string>(Object.entries(init ?? {}))
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v)
    },
  }
}

const KEY = 'status-deck:events:since:src1'

test('saveSince → loadSince で round-trip する', () => {
  const s = mockStorage()
  saveSince(s, 'src1', 42)
  expect(s.store.get(KEY)).toBe('42')
  expect(loadSince(s, 'src1')).toBe(42)
})

test('loadSince: 未保存なら 0', () => {
  expect(loadSince(mockStorage(), 'src1')).toBe(0)
})

test('loadSince: storage が undefined なら 0', () => {
  expect(loadSince(undefined, 'src1')).toBe(0)
})

test('loadSince: 純粋な非負整数のみ採用、それ以外は 0', () => {
  expect(loadSince(mockStorage({ [KEY]: '42' }), 'src1')).toBe(42)
  expect(loadSince(mockStorage({ [KEY]: '0' }), 'src1')).toBe(0)
  // 部分パース・非整数・指数・負・桁あふれは不正として 0 に倒す (parseInt の緩さを継がない)。
  expect(loadSince(mockStorage({ [KEY]: 'abc' }), 'src1')).toBe(0)
  expect(loadSince(mockStorage({ [KEY]: '42abc' }), 'src1')).toBe(0)
  expect(loadSince(mockStorage({ [KEY]: '3.5' }), 'src1')).toBe(0)
  expect(loadSince(mockStorage({ [KEY]: '1e3' }), 'src1')).toBe(0)
  expect(loadSince(mockStorage({ [KEY]: '-1' }), 'src1')).toBe(0)
  expect(loadSince(mockStorage({ [KEY]: '9'.repeat(20) }), 'src1')).toBe(0)
})

test('loadSince: getItem 例外は 0 (no-op)', () => {
  const s: Mock = {
    store: new Map(),
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {},
  }
  expect(loadSince(s, 'src1')).toBe(0)
})

test('saveSince: storage が undefined なら no-op (例外を投げない)', () => {
  expect(() => saveSince(undefined, 'src1', 5)).not.toThrow()
})

test('saveSince: 不正な since (非整数・負) は保存しない', () => {
  const s = mockStorage()
  saveSince(s, 'src1', -1)
  saveSince(s, 'src1', 1.5)
  expect(s.store.has(KEY)).toBe(false)
})

test('saveSince: setItem 例外 (quota 等) は no-op', () => {
  const s: Mock = {
    store: new Map(),
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceeded')
    },
  }
  expect(() => saveSince(s, 'src1', 10)).not.toThrow()
})

test('source 単位でキーが分かれる', () => {
  const s = mockStorage()
  saveSince(s, 'src1', 1)
  saveSince(s, 'src2', 2)
  expect(loadSince(s, 'src1')).toBe(1)
  expect(loadSince(s, 'src2')).toBe(2)
})
