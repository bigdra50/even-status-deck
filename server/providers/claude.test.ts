// claudeProvider の usage 集計に使う純粋関数の characterization テスト
// (localDateKey / pricingFor / addUsageLine / newAccum)。
// 実行: bun test server/providers/claude.test.ts
import { expect, test } from 'bun:test'
import { addUsageLine, localDateKey, newAccum, pricingFor } from './claude.ts'

test('localDateKey は ローカルタイムの YYYY-MM-DD を返す', () => {
  expect(localDateKey(new Date(2024, 0, 5))).toBe('2024-01-05') // 月初・1桁 zero-pad
  expect(localDateKey(new Date(2024, 11, 31))).toBe('2024-12-31')
})

test('pricingFor は model 名から opus/sonnet/haiku を判定する (既定 sonnet)', () => {
  expect(pricingFor('claude-opus-4-20250101')).toEqual({
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  })
  expect(pricingFor('claude-haiku-3-5')).toEqual({
    input: 0.8,
    output: 4,
    cacheWrite: 1,
    cacheRead: 0.08,
  })
  expect(pricingFor('claude-sonnet-4-5')).toEqual({
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  })
  expect(pricingFor('unknown-model')).toEqual({
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  })
})

const TODAY = '2024-06-01'

function assistantLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2024-06-01T12:00:00.000Z',
    message: {
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    ...over,
  })
}

test('addUsageLine: 今日分の assistant usage 行を加算する', () => {
  const acc = newAccum()
  addUsageLine(acc, assistantLine(), TODAY)
  expect(acc.messages).toBe(1)
  expect(acc.input).toBe(1000)
  expect(acc.output).toBe(500)
  // sonnet: 1000*3/1e6 + 500*15/1e6 = 0.003 + 0.0075 = 0.0105
  expect(acc.cost).toBeCloseTo(0.0105, 6)
})

test('addUsageLine: "usage" を含まない行は無視する', () => {
  const acc = newAccum()
  addUsageLine(acc, JSON.stringify({ type: 'assistant', timestamp: '2024-06-01T00:00:00Z' }), TODAY)
  expect(acc.messages).toBe(0)
})

test('addUsageLine: 不正 JSON は無視する (例外を投げない)', () => {
  const acc = newAccum()
  expect(() => addUsageLine(acc, '{not json "usage"', TODAY)).not.toThrow()
  expect(acc.messages).toBe(0)
})

test('addUsageLine: type !== assistant は無視する', () => {
  const acc = newAccum()
  addUsageLine(acc, assistantLine({ type: 'user' }), TODAY)
  expect(acc.messages).toBe(0)
})

test('addUsageLine: timestamp が今日でなければ無視する', () => {
  const acc = newAccum()
  addUsageLine(acc, assistantLine({ timestamp: '2020-01-01T00:00:00.000Z' }), TODAY)
  expect(acc.messages).toBe(0)
})

test('addUsageLine: usage が無ければ無視する', () => {
  const acc = newAccum()
  addUsageLine(
    acc,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2024-06-01T00:00:00.000Z',
      message: { model: 'claude-sonnet-4-5' },
      usage: {}, // top-level usage は対象外 (message.usage のみ見る)
    }),
    TODAY,
  )
  expect(acc.messages).toBe(0)
})

test('addUsageLine: 複数行を累積し、cache_* / opus 単価も合算する', () => {
  const acc = newAccum()
  addUsageLine(acc, assistantLine(), TODAY)
  addUsageLine(
    acc,
    assistantLine({
      message: {
        model: 'claude-opus-4-1',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
        },
      },
    }),
    TODAY,
  )
  expect(acc.messages).toBe(2)
  expect(acc.input).toBe(1100)
  expect(acc.output).toBe(550)
  expect(acc.cacheWrite).toBe(10)
  expect(acc.cacheRead).toBe(20)
})
