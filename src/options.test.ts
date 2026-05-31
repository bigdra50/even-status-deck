// 表示オプション基盤 (#36) の純粋ロジック: schema / 解決 (default 込み) / 書込 (clock は format 合成)。
// 実行: bun test src/options.test.ts
import { expect, test } from 'bun:test'
import { BUILTIN_SOURCE_ID, type Config, emptyConfig } from './config'
import {
  resolveSegmentOptions,
  resolveSourceOptions,
  segmentOptionSchema,
  setSegmentOption,
  setSourceOption,
  sourceOptionSchema,
} from './options'

// clock の datetime segment 素材を持つ最小 config を作る (resolve/set が読み書きする先)。
function cfgWithClock(): Config {
  const c = emptyConfig()
  c.groups[BUILTIN_SOURCE_ID] ??= {}
  c.groups[BUILTIN_SOURCE_ID].clock = { segments: [{ id: 'datetime' }] }
  return c
}

test('segmentOptionSchema: clock datetime は Time/Date/Order の 3 select', () => {
  const fields = segmentOptionSchema(BUILTIN_SOURCE_ID, 'clock', 'datetime')
  expect(fields.map((f) => f.id)).toEqual(['time', 'date', 'order'])
  expect(fields.every((f) => f.kind === 'select')).toBe(true)
})

test('segmentOptionSchema / sourceOptionSchema: 未知 source は空', () => {
  expect(segmentOptionSchema('client.unknown', 'g', 's')).toEqual([])
  expect(segmentOptionSchema(BUILTIN_SOURCE_ID, 'g2', 'level')).toEqual([])
  expect(sourceOptionSchema('client.weather')).toEqual([])
})

test('clock: setSegmentOption が format に合成され resolveSegmentOptions で復元できる (round-trip)', () => {
  const c = cfgWithClock()
  expect(setSegmentOption(c, BUILTIN_SOURCE_ID, 'clock', 'datetime', 'time', 'HH:mm')).toBe(true)
  expect(setSegmentOption(c, BUILTIN_SOURCE_ID, 'clock', 'datetime', 'date', 'MMM DD')).toBe(true)
  const sm = c.groups[BUILTIN_SOURCE_ID].clock.segments[0]
  expect(sm.format).toBe('HH:mm  MMM DD')
  expect(sm.options).toBeUndefined() // clock は options バッグを使わない (後方互換)

  const r = resolveSegmentOptions(c, BUILTIN_SOURCE_ID, 'clock', 'datetime')
  expect(r).toEqual({ time: 'HH:mm', date: 'MMM DD', order: 'time' })

  // Order = date で Date → Time の順に合成される。
  expect(setSegmentOption(c, BUILTIN_SOURCE_ID, 'clock', 'datetime', 'order', 'date')).toBe(true)
  expect(sm.format).toBe('MMM DD  HH:mm')
  expect(resolveSegmentOptions(c, BUILTIN_SOURCE_ID, 'clock', 'datetime').order).toBe('date')
})

test('setSegmentOption: segment 不在 / 未知 field は false', () => {
  const c = cfgWithClock()
  expect(setSegmentOption(c, BUILTIN_SOURCE_ID, 'clock', 'nope', 'time', 'HH:mm')).toBe(false)
  expect(setSegmentOption(c, BUILTIN_SOURCE_ID, 'clock', 'datetime', 'bogus', 'x')).toBe(false)
})

test('setSourceOption: スキーマの無い source は false (書き込まない)', () => {
  const c = emptyConfig()
  expect(setSourceOption(c, 'client.weather', 'tempUnit', 'F')).toBe(false)
})

test('resolveSourceOptions / resolveSegmentOptions: スキーマ空なら {}', () => {
  const c = emptyConfig()
  expect(resolveSourceOptions(c, 'client.weather')).toEqual({})
  expect(resolveSegmentOptions(c, BUILTIN_SOURCE_ID, 'g2', 'level')).toEqual({})
})
