// glass-sync (applied-state 同期) のテスト。送信成功後にのみ state を更新する規律と、
// 1 セル差分= upgrade / 多セル差分・幾何変化 = rebuild / 失敗 = invalidate→rebuild を固定する。
// 実行: bun test src/glass-sync.test.ts
import { expect, test } from 'bun:test'
import type { CompiledCell } from './glass-layout'
import { createContainerSync, topoKey } from './glass-sync'

const cell = (over: Partial<CompiledCell> = {}): CompiledCell => ({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 0,
  paddingLength: 8,
  containerID: 1,
  containerName: 'toolbar',
  content: 'a',
  isEventCapture: 1,
  ...over,
})

type Call = { kind: 'rebuild' | 'upgrade'; detail: string }
function harness(results: { rebuild?: boolean[]; upgrade?: boolean[] } = {}) {
  const calls: Call[] = []
  const rq = [...(results.rebuild ?? [])]
  const uq = [...(results.upgrade ?? [])]
  const sync = createContainerSync({
    rebuild: (cells) => {
      calls.push({ kind: 'rebuild', detail: cells.map((c) => c.containerName).join(',') })
      return Promise.resolve(rq.shift() ?? true)
    },
    upgrade: (t) => {
      calls.push({ kind: 'upgrade', detail: `${t.containerName}:${t.content}` })
      return Promise.resolve(uq.shift() ?? true)
    },
  })
  return { sync, calls }
}

test('初回 apply は rebuild、同一集合の再 apply は無送信', async () => {
  const { sync, calls } = harness()
  await sync.apply([cell()])
  await sync.apply([cell()])
  expect(calls).toEqual([{ kind: 'rebuild', detail: 'toolbar' }])
})

test('content 1 セル差分は upgrade のみ (cheap path)', async () => {
  const { sync, calls } = harness()
  await sync.apply([cell()])
  await sync.apply([cell({ content: 'b' })])
  expect(calls).toEqual([
    { kind: 'rebuild', detail: 'toolbar' },
    { kind: 'upgrade', detail: 'toolbar:b' },
  ])
  // upgrade 成功後は applied が更新済み → 同一 content の再 apply は無送信
  await sync.apply([cell({ content: 'b' })])
  expect(calls).toHaveLength(2)
})

test('2 セル以上の content 差分は rebuild (混在表示を避ける)', async () => {
  const { sync, calls } = harness()
  const two = [
    cell({ containerID: 1, containerName: 'a1', width: 288 }),
    cell({ containerID: 2, containerName: 'a2', xPosition: 288, width: 288 }),
  ]
  await sync.apply(two)
  await sync.apply(two.map((c) => ({ ...c, content: 'x' })))
  expect(calls.map((c) => c.kind)).toEqual(['rebuild', 'rebuild'])
})

test('幾何 (topology) が変わると content 同一でも rebuild', async () => {
  const { sync, calls } = harness()
  await sync.apply([cell()])
  await sync.apply([cell({ width: 288 })])
  expect(calls.map((c) => c.kind)).toEqual(['rebuild', 'rebuild'])
})

test('rebuild 失敗 (false) は state を残さない → 次回 apply で再 rebuild', async () => {
  const { sync, calls } = harness({ rebuild: [false, true] })
  await sync.apply([cell()])
  await sync.apply([cell()]) // 同一集合でも前回失敗なので再送
  expect(calls.map((c) => c.kind)).toEqual(['rebuild', 'rebuild'])
})

test('upgrade 失敗は invalidate → 次回 apply は rebuild に倒れる', async () => {
  const { sync, calls } = harness({ upgrade: [false] })
  await sync.apply([cell()])
  await sync.apply([cell({ content: 'b' })]) // upgrade 失敗
  await sync.apply([cell({ content: 'b' })]) // invalidate 済 → rebuild
  expect(calls.map((c) => c.kind)).toEqual(['rebuild', 'upgrade', 'rebuild'])
})

test('seed は送信なしで applied を確立する (起動ページ作成後)', async () => {
  const { sync, calls } = harness()
  sync.seed([cell()])
  await sync.apply([cell()])
  expect(calls).toHaveLength(0)
  await sync.apply([cell({ content: 'b' })])
  expect(calls).toEqual([{ kind: 'upgrade', detail: 'toolbar:b' }])
})

test('invalidate 後は同一集合でも rebuild (overlay が別集合を送った後)', async () => {
  const { sync, calls } = harness()
  await sync.apply([cell()])
  sync.invalidate()
  await sync.apply([cell()])
  expect(calls.map((c) => c.kind)).toEqual(['rebuild', 'rebuild'])
})

test('topoKey は content を含まず、幾何/様式/順序を含む', () => {
  expect(topoKey([cell({ content: 'a' })])).toBe(topoKey([cell({ content: 'b' })]))
  expect(topoKey([cell()])).not.toBe(topoKey([cell({ borderRadius: 4 })]))
  const a = cell({ containerID: 1, containerName: 'a1', width: 288 })
  const b = cell({ containerID: 2, containerName: 'a2', xPosition: 288, width: 288 })
  expect(topoKey([a, b])).not.toBe(topoKey([b, a]))
})
