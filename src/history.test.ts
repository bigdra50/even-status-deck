// 数値履歴 (sparkline データ源) のテスト。
// 実行: bun test src/history.test.ts
import { beforeEach, expect, test } from 'bun:test'
import {
  historyOf,
  numericValueOf,
  recordHistory,
  recordStatusHistory,
  resetHistory,
} from './history'

beforeEach(() => resetHistory())

test('numericValueOf: percent 優先、無ければ値先頭の数値、数値なしは null', () => {
  expect(numericValueOf({ value: '42%', percent: 42 })).toBe(42)
  expect(numericValueOf({ value: '3.2GB' })).toBe(3.2)
  expect(numericValueOf({ value: '-5°C' })).toBe(-5)
  expect(numericValueOf({ value: 'offline' })).toBeNull()
})

test('recordHistory: 最小間隔内は最新値で上書き、超えたら追記、64 件で ring', () => {
  recordHistory('k', 1, 0)
  recordHistory('k', 2, 1000) // 5s 以内 → 上書き
  expect(historyOf('k')).toEqual([{ t: 0, v: 2 }])
  for (let i = 1; i <= 70; i++) recordHistory('k', i, i * 10_000)
  expect(historyOf('k')).toHaveLength(64)
  expect(historyOf('k')[63]).toEqual({ t: 700_000, v: 70 })
})

test('recordStatusHistory: 数値を持つ segment だけ segKey で記録する', () => {
  recordStatusHistory(
    'src',
    {
      version: 1,
      ts: 0,
      groups: [
        {
          id: 'g',
          label: '',
          segments: [
            { id: 'num', label: '', value: '80%', percent: 80 },
            { id: 'text', label: '', value: 'ok' },
          ],
        },
      ],
    },
    0,
  )
  expect(historyOf('src|g|num')).toEqual([{ t: 0, v: 80 }])
  expect(historyOf('src|g|text')).toEqual([])
})
