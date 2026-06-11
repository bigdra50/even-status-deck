// ttl-cache.ts: 位置ベース TTL cache(localStorage)の read/write/fresh/stale 判定。
// 実行: bun test src/ttl-cache.test.ts
import { afterEach, expect, test } from 'bun:test'
import {
  type GeoCacheEntry,
  isCacheFresh,
  isCacheStaleOk,
  readGeoCache,
  writeGeoCache,
} from './ttl-cache'

const KEY = 'test.ttl-cache'

// localStorage 互換の最小モック。bun test 環境には window が無いので globalThis に生やす。
function mockWindow(init?: Record<string, string>): Map<string, string> {
  const store = new Map<string, string>(Object.entries(init ?? {}))
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
    },
  }
  return store
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

type Payload = { value: string }

function parsePayload(raw: unknown): Payload | null {
  if (!raw || typeof raw !== 'object') return null
  const v = (raw as Record<string, unknown>).value
  return typeof v === 'string' ? { value: v } : null
}

test('writeGeoCache → readGeoCache で round-trip する', () => {
  mockWindow()
  const entry: GeoCacheEntry<Payload> = {
    lat: 35.68,
    lon: 139.61,
    fetchedAt: 1000,
    payload: { value: 'a' },
  }
  writeGeoCache(KEY, entry)
  expect(readGeoCache(KEY, parsePayload)).toEqual(entry)
})

test('readGeoCache: 未保存なら null', () => {
  mockWindow()
  expect(readGeoCache(KEY, parsePayload)).toBeNull()
})

test('readGeoCache: window が無ければ null', () => {
  expect(readGeoCache(KEY, parsePayload)).toBeNull()
})

test('readGeoCache: 壊れた JSON は null', () => {
  mockWindow({ [KEY]: '{not json' })
  expect(readGeoCache(KEY, parsePayload)).toBeNull()
})

test('readGeoCache: lat/lon/fetchedAt の型不一致は null', () => {
  mockWindow({
    [KEY]: JSON.stringify({ lat: '35.68', lon: 139.61, fetchedAt: 1000, payload: { value: 'a' } }),
  })
  expect(readGeoCache(KEY, parsePayload)).toBeNull()
})

test('readGeoCache: parsePayload が null を返す payload は null', () => {
  mockWindow({
    [KEY]: JSON.stringify({ lat: 35.68, lon: 139.61, fetchedAt: 1000, payload: { value: 42 } }),
  })
  expect(readGeoCache(KEY, parsePayload)).toBeNull()
})

test('readGeoCache: optSig は文字列以外なら undefined に倒す', () => {
  mockWindow({
    [KEY]: JSON.stringify({ lat: 0, lon: 0, fetchedAt: 1000, optSig: 42, payload: { value: 'a' } }),
  })
  expect(readGeoCache(KEY, parsePayload)?.optSig).toBeUndefined()
})

test('writeGeoCache: window が無ければ no-op (例外を投げない)', () => {
  expect(() =>
    writeGeoCache(KEY, { lat: 0, lon: 0, fetchedAt: 1, payload: { value: 'a' } }),
  ).not.toThrow()
})

test('writeGeoCache: setItem が例外でも no-op', () => {
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    },
  }
  expect(() =>
    writeGeoCache(KEY, { lat: 0, lon: 0, fetchedAt: 1, payload: { value: 'a' } }),
  ).not.toThrow()
})

const FRESH_MS = 1000
const STALE_MAX_MS = 5000

test('isCacheFresh: fetchedAt から freshMs 未満なら fresh', () => {
  const cache: GeoCacheEntry<Payload> = { lat: 0, lon: 0, fetchedAt: 1000, payload: { value: 'a' } }
  expect(isCacheFresh(cache, 1500, FRESH_MS)).toBe(true) // 経過 500 < 1000
  expect(isCacheFresh(cache, 2000, FRESH_MS)).toBe(false) // 経過 1000 は未満ではない(expired)
  expect(isCacheFresh(cache, 3000, FRESH_MS)).toBe(false) // expired
})

test('isCacheFresh: cache が null なら false', () => {
  expect(isCacheFresh(null, 1000, FRESH_MS)).toBe(false)
})

test('isCacheFresh: optSig 指定時は一致も必須(不一致は invalidation)', () => {
  const cache: GeoCacheEntry<Payload> = {
    lat: 0,
    lon: 0,
    fetchedAt: 1000,
    optSig: 'C|kmh',
    payload: { value: 'a' },
  }
  expect(isCacheFresh(cache, 1100, FRESH_MS, 'C|kmh')).toBe(true) // fresh かつ一致
  expect(isCacheFresh(cache, 1100, FRESH_MS, 'F|mph')).toBe(false) // fresh でも不一致なら invalidation
})

test('isCacheFresh: optSig を渡さなければ optSig は比較しない(geocode/geoinfo)', () => {
  const cache: GeoCacheEntry<Payload> = { lat: 0, lon: 0, fetchedAt: 1000, payload: { value: 'a' } }
  expect(isCacheFresh(cache, 1100, FRESH_MS)).toBe(true)
})

test('isCacheStaleOk: fetchedAt から staleMaxMs 未満なら stale 表示可', () => {
  const cache: GeoCacheEntry<Payload> = { lat: 0, lon: 0, fetchedAt: 1000, payload: { value: 'a' } }
  expect(isCacheStaleOk(cache, 1000 + STALE_MAX_MS - 1, STALE_MAX_MS)).toBe(true)
  expect(isCacheStaleOk(cache, 1000 + STALE_MAX_MS, STALE_MAX_MS)).toBe(false)
})

test('isCacheStaleOk: cache が null なら false', () => {
  expect(isCacheStaleOk(null, 1000, STALE_MAX_MS)).toBe(false)
})
