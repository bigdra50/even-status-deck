// status-types の検証/サニタイズ (parseStatusDoc)。protocol boundary (PROTOCOL §3, untrusted input)。
// リファクタ前の現行挙動を pin する characterization tests。
// 実行: bun test src/status-types.test.ts
import { expect, test } from 'bun:test'
import { parseStatusDoc } from './status-types'

// --- 致命的に壊れている入力 → null ---

test('null / 非object → null', () => {
  expect(parseStatusDoc(null)).toBeNull()
  expect(parseStatusDoc(undefined)).toBeNull()
  expect(parseStatusDoc('string')).toBeNull()
  expect(parseStatusDoc(42)).toBeNull()
  expect(parseStatusDoc(true)).toBeNull()
})

test('version が number でない → null', () => {
  expect(parseStatusDoc({ version: '1', groups: [] })).toBeNull()
  expect(parseStatusDoc({ groups: [] })).toBeNull()
})

test('groups が配列でない → null', () => {
  expect(parseStatusDoc({ version: 1, groups: {} })).toBeNull()
  expect(parseStatusDoc({ version: 1 })).toBeNull()
})

// --- 正常系: round-trip ---

test('valid doc: round-trip でフィールドを保持する', () => {
  const input = {
    version: 1,
    ts: 12345,
    groups: [
      {
        id: 'g1',
        label: 'Group 1',
        state: 'ok',
        message: 'all good',
        anchors: { sunrise: 100, sunset: 200 },
        segments: [
          {
            id: 's1',
            label: 'Seg 1',
            value: '42%',
            percent: 42,
            reset: '2h13m',
            defaultEnabled: true,
            state: 'stale',
            message: 'using cache',
          },
        ],
      },
    ],
  }
  const out = parseStatusDoc(input)
  expect(out).toEqual({
    version: 1,
    ts: 12345,
    groups: [
      {
        id: 'g1',
        label: 'Group 1',
        state: 'ok',
        message: 'all good',
        anchors: { sunrise: 100, sunset: 200 },
        segments: [
          {
            id: 's1',
            label: 'Seg 1',
            value: '42%',
            percent: 42,
            reset: '2h13m',
            defaultEnabled: true,
            state: 'stale',
            message: 'using cache',
          },
        ],
      },
    ],
  })
})

test('ts 省略時は Date.now() が補完される', () => {
  const before = Date.now()
  const out = parseStatusDoc({ version: 1, groups: [] })
  const after = Date.now()
  expect(out).not.toBeNull()
  expect(out?.ts).toBeGreaterThanOrEqual(before)
  expect(out?.ts).toBeLessThanOrEqual(after)
})

test('groups 0件は許容される (空 doc)', () => {
  expect(parseStatusDoc({ version: 1, ts: 1, groups: [] })).toEqual({
    version: 1,
    ts: 1,
    groups: [],
  })
})

// --- group のフィールド検証/破棄 ---

test('group: id/label/segments のいずれかが欠落・型違いなら丸ごと破棄', () => {
  const base = { version: 1, ts: 1 }
  expect(parseStatusDoc({ ...base, groups: [{ label: 'L', segments: [] }] })).toEqual({
    ...base,
    groups: [],
  })
  expect(parseStatusDoc({ ...base, groups: [{ id: 'g', segments: [] }] })).toEqual({
    ...base,
    groups: [],
  })
  expect(parseStatusDoc({ ...base, groups: [{ id: 'g', label: 'L' }] })).toEqual({
    ...base,
    groups: [],
  })
  expect(parseStatusDoc({ ...base, groups: [{ id: 1, label: 'L', segments: [] }] })).toEqual({
    ...base,
    groups: [],
  })
})

test('group: 配列でない/null要素は無視される', () => {
  const out = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [null, 'bad', 42, { id: 'g1', label: 'G1', segments: [] }],
  })
  expect(out?.groups).toEqual([{ id: 'g1', label: 'G1', segments: [] }])
})

// --- segment のフィールド検証/破棄 ---

test('segment: id/label/value のいずれかが欠落・型違いなら丸ごと破棄', () => {
  const mk = (seg: unknown) => ({
    version: 1,
    ts: 1,
    groups: [{ id: 'g1', label: 'G1', segments: [seg] }],
  })
  expect(parseStatusDoc(mk({ label: 'L', value: 'v' }))?.groups[0].segments).toEqual([])
  expect(parseStatusDoc(mk({ id: 's', value: 'v' }))?.groups[0].segments).toEqual([])
  expect(parseStatusDoc(mk({ id: 's', label: 'L' }))?.groups[0].segments).toEqual([])
  expect(parseStatusDoc(mk({ id: 's', label: 'L', value: 1 }))?.groups[0].segments).toEqual([])
  expect(parseStatusDoc(mk(null))?.groups[0].segments).toEqual([])
  expect(parseStatusDoc(mk('bad'))?.groups[0].segments).toEqual([])
})

test('segment: optional フィールドは型が合うときだけ採用される', () => {
  const mk = (seg: unknown) => ({
    version: 1,
    ts: 1,
    groups: [{ id: 'g1', label: 'G1', segments: [seg] }],
  })
  // percent が number でなければ落ちる
  const noPercent = parseStatusDoc(mk({ id: 's', label: 'L', value: 'v', percent: '50' }))
  expect(noPercent?.groups[0].segments[0]).toEqual({ id: 's', label: 'L', value: 'v' })

  // reset が string でなければ落ちる
  const noReset = parseStatusDoc(mk({ id: 's', label: 'L', value: 'v', reset: 123 }))
  expect(noReset?.groups[0].segments[0]).toEqual({ id: 's', label: 'L', value: 'v' })

  // defaultEnabled が boolean でなければ落ちる
  const noDefault = parseStatusDoc(mk({ id: 's', label: 'L', value: 'v', defaultEnabled: 'yes' }))
  expect(noDefault?.groups[0].segments[0]).toEqual({ id: 's', label: 'L', value: 'v' })

  // state が不正な値なら落ちる
  const badState = parseStatusDoc(mk({ id: 's', label: 'L', value: 'v', state: 'unknown' }))
  expect(badState?.groups[0].segments[0]).toEqual({ id: 's', label: 'L', value: 'v' })

  // message が string でなければ落ちる
  const noMessage = parseStatusDoc(mk({ id: 's', label: 'L', value: 'v', message: 42 }))
  expect(noMessage?.groups[0].segments[0]).toEqual({ id: 's', label: 'L', value: 'v' })

  // 全部 valid なら採用される
  const all = parseStatusDoc(
    mk({
      id: 's',
      label: 'L',
      value: 'v',
      percent: 50,
      reset: '1h',
      defaultEnabled: false,
      state: 'error',
      message: 'msg',
    }),
  )
  expect(all?.groups[0].segments[0]).toEqual({
    id: 's',
    label: 'L',
    value: 'v',
    percent: 50,
    reset: '1h',
    defaultEnabled: false,
    state: 'error',
    message: 'msg',
  })
})

// --- state 検証 (asState): 'ok' | 'stale' | 'error' のみ採用、それ以外は省略 ---

test('group/segment の state: ok|stale|error 以外は省略される', () => {
  const mk = (groupState: unknown, segState: unknown) => ({
    version: 1,
    ts: 1,
    groups: [
      {
        id: 'g1',
        label: 'G1',
        state: groupState,
        segments: [{ id: 's1', label: 'S1', value: 'v', state: segState }],
      },
    ],
  })
  const valid = parseStatusDoc(mk('stale', 'error'))
  expect(valid?.groups[0].state).toBe('stale')
  expect(valid?.groups[0].segments[0].state).toBe('error')

  const invalid = parseStatusDoc(mk('weird', 123))
  expect(invalid?.groups[0].state).toBeUndefined()
  expect(invalid?.groups[0].segments[0].state).toBeUndefined()
})

// --- 数量上限 (caps) ---

test('groups は MAX_GROUPS=24 件で打ち切られる', () => {
  const groups = Array.from({ length: 30 }, (_, i) => ({
    id: `g${i}`,
    label: `G${i}`,
    segments: [],
  }))
  const out = parseStatusDoc({ version: 1, ts: 1, groups })
  expect(out?.groups).toHaveLength(24)
  expect(out?.groups[23].id).toBe('g23')
})

test('segments は MAX_SEGMENTS=24 件で打ち切られる', () => {
  const segments = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    label: `S${i}`,
    value: 'v',
  }))
  const out = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [{ id: 'g1', label: 'G1', segments }],
  })
  expect(out?.groups[0].segments).toHaveLength(24)
  expect(out?.groups[0].segments[23].id).toBe('s23')
})

test('group.id が MAX_ID_LEN=64 を超えると group ごと破棄される', () => {
  const longId = 'x'.repeat(65)
  const okId = 'x'.repeat(64)
  const out = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [
      { id: longId, label: 'G', segments: [] },
      { id: okId, label: 'G', segments: [] },
    ],
  })
  expect(out?.groups).toHaveLength(1)
  expect(out?.groups[0].id).toBe(okId)
})

test('segment.id が MAX_ID_LEN=64 を超えると segment ごと破棄される', () => {
  const longId = 'y'.repeat(65)
  const okId = 'y'.repeat(64)
  const out = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [
      {
        id: 'g1',
        label: 'G1',
        segments: [
          { id: longId, label: 'S', value: 'v' },
          { id: okId, label: 'S', value: 'v' },
        ],
      },
    ],
  })
  expect(out?.groups[0].segments).toHaveLength(1)
  expect(out?.groups[0].segments[0].id).toBe(okId)
})

// --- 文字列長上限 (clip) ---

test('group.label / message は MAX_LABEL_LEN=48 / MAX_MESSAGE_LEN=120 で切り詰められる', () => {
  const longLabel = 'a'.repeat(60)
  const longMessage = 'b'.repeat(130)
  const out = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [{ id: 'g1', label: longLabel, message: longMessage, segments: [] }],
  })
  expect(out?.groups[0].label).toBe('a'.repeat(48))
  expect(out?.groups[0].message).toBe('b'.repeat(120))
})

test('segment.label / value / reset / message は各上限で切り詰められる', () => {
  const longLabel = 'a'.repeat(60) // > MAX_LABEL_LEN=48
  const longValue = 'b'.repeat(140) // > MAX_VALUE_LEN=128
  const longReset = 'c'.repeat(40) // > MAX_RESET_LEN=32
  const longMessage = 'd'.repeat(130) // > MAX_MESSAGE_LEN=120
  const out = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [
      {
        id: 'g1',
        label: 'G1',
        segments: [
          {
            id: 's1',
            label: longLabel,
            value: longValue,
            reset: longReset,
            message: longMessage,
          },
        ],
      },
    ],
  })
  const seg = out?.groups[0].segments[0]
  expect(seg?.label).toBe('a'.repeat(48))
  expect(seg?.value).toBe('b'.repeat(128))
  expect(seg?.reset).toBe('c'.repeat(32))
  expect(seg?.message).toBe('d'.repeat(120))
})

// --- anchors (#38 sun epoch) ---

test('anchors: 数値キーのみ採用し MAX_ANCHORS=8 で打ち切る。空なら未設定', () => {
  const anchors: Record<string, unknown> = {}
  for (let i = 0; i < 12; i++) anchors[`k${i}`] = i
  anchors.notNumber = 'x' // 数値でないものは無視 (カウントに含まれない)
  const out = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [{ id: 'g1', label: 'G1', anchors, segments: [] }],
  })
  const a = out?.groups[0].anchors
  expect(a).toBeDefined()
  expect(Object.keys(a ?? {})).toHaveLength(8)
  expect(a?.k0).toBe(0)
  expect(a?.notNumber).toBeUndefined()
})

test('anchors: 非finite (NaN/Infinity) は無視される', () => {
  const out = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [
      {
        id: 'g1',
        label: 'G1',
        anchors: { ok: 1, nan: Number.NaN, inf: Number.POSITIVE_INFINITY },
        segments: [],
      },
    ],
  })
  expect(out?.groups[0].anchors).toEqual({ ok: 1 })
})

test('anchors: キー長が MAX_ID_LEN=64 を超えるものは無視される', () => {
  const longKey = 'k'.repeat(65)
  const okKey = 'k'.repeat(64)
  const out = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [
      {
        id: 'g1',
        label: 'G1',
        anchors: { [longKey]: 1, [okKey]: 2 },
        segments: [],
      },
    ],
  })
  expect(out?.groups[0].anchors).toEqual({ [okKey]: 2 })
})

test('anchors: 空オブジェクト/不正型なら group.anchors は未設定', () => {
  const out1 = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [{ id: 'g1', label: 'G1', anchors: {}, segments: [] }],
  })
  expect(out1?.groups[0].anchors).toBeUndefined()

  const out2 = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [{ id: 'g1', label: 'G1', anchors: { onlyBad: 'x' }, segments: [] }],
  })
  expect(out2?.groups[0].anchors).toBeUndefined()

  const out3 = parseStatusDoc({
    version: 1,
    ts: 1,
    groups: [{ id: 'g1', label: 'G1', anchors: 'not-an-object', segments: [] }],
  })
  expect(out3?.groups[0].anchors).toBeUndefined()
})
