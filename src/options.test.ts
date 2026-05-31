// 表示オプション基盤 (#36) の純粋ロジック: schema / 解決 (default 込み) / 書込 (clock は format 合成)。
// 実行: bun test src/options.test.ts
import { expect, test } from 'bun:test'
import { BUILTIN_SOURCE_ID, type Config, emptyConfig, sourceById } from './config'
import {
  applyDefaults,
  coerce,
  type OptionField,
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
  expect(sourceOptionSchema('client.unknown')).toEqual([]) // weather 以外は空
})

test('sourceOptionSchema: client.weather は単位/フォーマット/降水の option 群 (#38/#40/#39)', () => {
  const fields = sourceOptionSchema('client.weather')
  expect(fields.map((f) => f.id)).toEqual([
    'tempUnit',
    'windUnit',
    'windDir',
    'presUnit',
    'stormSensitivity',
    'sunFormat',
    'rainMode',
    'rainThreshold',
    'rainGranularity',
  ])
  // rainThreshold のみ number、それ以外は select。
  expect(fields.find((f) => f.id === 'rainThreshold')?.kind).toBe('number')
  expect(fields.filter((f) => f.id !== 'rainThreshold').every((f) => f.kind === 'select')).toBe(
    true,
  )
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

test('setSourceOption: スキーマの無い source は false / weather は書き込める', () => {
  const c = emptyConfig() // ensureClientWeather で client.weather は実在する
  expect(setSourceOption(c, 'client.unknown', 'tempUnit', 'F')).toBe(false) // schema 無し
  expect(setSourceOption(c, 'client.weather', 'tempUnit', 'F')).toBe(true)
  expect(sourceById(c, 'client.weather')?.options?.tempUnit).toBe('F')
  expect(setSourceOption(c, 'client.weather', 'bogusField', 'x')).toBe(false) // 未知 field
})

test('resolveSourceOptions / resolveSegmentOptions: スキーマ空なら {} / weather は default 解決', () => {
  const c = emptyConfig()
  expect(resolveSourceOptions(c, 'client.unknown')).toEqual({}) // schema 無し
  expect(resolveSegmentOptions(c, BUILTIN_SOURCE_ID, 'g2', 'level')).toEqual({})
  expect(resolveSourceOptions(c, 'client.weather')).toEqual({
    tempUnit: 'C',
    windUnit: 'kmh',
    windDir: 'text',
    presUnit: 'hPa',
    stormSensitivity: 'normal',
    sunFormat: 'auto',
    rainMode: 'nextrain',
    rainThreshold: 0.1,
    rainGranularity: 'auto',
  })
})

// ── coerce / applyDefaults (#36 の中核バリデーション。clock 以外の利用者が乗る前にここで回帰を止める) ──
// 現状 toggle/number/select-非clock を叩く公開 schema が無いため、後続 issue が乗る前の唯一の網。
const SEL: OptionField = {
  kind: 'select',
  id: 'unit',
  label: 'Unit',
  choices: [
    { value: 'C', label: 'C' },
    { value: 'F', label: 'F' },
  ],
  default: 'C',
}
const TOG: OptionField = { kind: 'toggle', id: 'flag', label: 'Flag', default: false }
const NUM: OptionField = { kind: 'number', id: 'n', label: 'N', min: 0, max: 10, default: 3 }

test('coerce(select): 有効 choice はそのまま、未知値は default', () => {
  const cases: [unknown, string][] = [
    ['F', 'F'],
    ['C', 'C'],
    ['bogus', 'C'], // 未知 → default
    [undefined, 'C'], // String(undefined)='undefined' は choice 外 → default
    [1, 'C'], // String(1)='1' は choice 外 → default
  ]
  for (const [raw, want] of cases) expect(coerce(SEL, raw)).toBe(want)
})

test('coerce(toggle): boolean は素通し、文字列/数値は truthy 表現のみ true', () => {
  const cases: [unknown, boolean][] = [
    [true, true],
    [false, false],
    ['true', true],
    ['1', true],
    [1, true],
    ['false', false],
    ['0', false],
    [0, false],
    ['no', false],
    [undefined, false],
    [null, false],
  ]
  for (const [raw, want] of cases) expect(coerce(TOG, raw)).toBe(want)
})

test('coerce(number): clamp と不正値の default フォールバック', () => {
  const cases: [unknown, number][] = [
    [5, 5],
    [0, 0],
    [10, 10],
    [-3, 0], // min clamp
    [99, 10], // max clamp
    ['7', 7], // 数値文字列
    ['abc', 3], // NaN → default
    [Number.NaN, 3],
    [Number.POSITIVE_INFINITY, 3], // 非有限 → default
    [null, 0], // Number(null)=0 → clamp 内
  ]
  for (const [raw, want] of cases) expect(coerce(NUM, raw)).toBe(want)
})

test('applyDefaults: 未設定は default、未知キーは無視、不正値は coerce で矯正', () => {
  expect(applyDefaults([SEL, NUM], undefined)).toEqual({ unit: 'C', n: 3 })
  expect(applyDefaults([SEL, NUM], { unit: 'F' })).toEqual({ unit: 'F', n: 3 }) // 部分指定
  expect(applyDefaults([NUM], { n: 99, extra: 'x' })).toEqual({ n: 10 }) // 未知キー無視 + clamp
  expect(applyDefaults([NUM], { n: -5 })).toEqual({ n: 0 })
  expect(applyDefaults([], { whatever: 1 })).toEqual({}) // field が無ければ常に空
})
