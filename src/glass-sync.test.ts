// glass-sync (applied-state 同期) のテスト。送信成功後にのみ state を更新する規律と、
// 1 セル差分= upgrade / 多セル差分・幾何変化 = rebuild / 失敗 = invalidate→rebuild を固定する。
// 実行: bun test src/glass-sync.test.ts
import { expect, test } from 'bun:test'
import type { CompiledCell } from './glass-layout'
import type { CompiledImageCell } from './glass-render'
import { createContainerSync, type SyncImage, topoKey } from './glass-sync'

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

const img = (over: Partial<CompiledImageCell> = {}): SyncImage => ({
  xPosition: 0,
  yPosition: 144,
  width: 96,
  height: 58,
  containerID: 30,
  containerName: 'img1',
  image: { source: 'icon', icon: 'battery' },
  dataKey: 'icon:battery',
  ...over,
})

type Call = { kind: 'rebuild' | 'upgrade' | 'image'; detail: string }
type ImgResult = 'sent' | 'skip' | 'fail'
function harness(results: { rebuild?: boolean[]; upgrade?: boolean[]; image?: ImgResult[] } = {}) {
  const calls: Call[] = []
  const rq = [...(results.rebuild ?? [])]
  const uq = [...(results.upgrade ?? [])]
  const iq = [...(results.image ?? [])]
  const sync = createContainerSync({
    rebuild: (cells, images) => {
      calls.push({
        kind: 'rebuild',
        detail: [...cells, ...images].map((c) => c.containerName).join(','),
      })
      return Promise.resolve(rq.shift() ?? true)
    },
    upgrade: (t) => {
      calls.push({ kind: 'upgrade', detail: `${t.containerName}:${t.content}` })
      return Promise.resolve(uq.shift() ?? true)
    },
    sendImage: (i) => {
      calls.push({ kind: 'image', detail: i.containerName })
      return Promise.resolve(iq.shift() ?? 'sent')
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

test('image: rebuild 成功後に実体を直列送信し、同一 dataKey の再 apply では送らない', async () => {
  const { sync, calls } = harness()
  await sync.apply([cell()], [img()])
  expect(calls).toEqual([
    { kind: 'rebuild', detail: 'toolbar,img1' },
    { kind: 'image', detail: 'img1' },
  ])
  await sync.apply([cell()], [img()]) // 同一 topo + 同一 dataKey → 無送信
  expect(calls).toHaveLength(2)
})

test('image: dataKey 変化 (sparkline 更新) は topo 不変のまま実体だけ再送する', async () => {
  const { sync, calls } = harness()
  await sync.apply([cell()], [img()])
  await sync.apply([cell()], [img({ dataKey: 'spark:v2' })])
  expect(calls.map((c) => c.kind)).toEqual(['rebuild', 'image', 'image'])
})

test('image: 送信失敗は invalidate → 次回 rebuild + 全画像再送', async () => {
  const { sync, calls } = harness({ image: ['fail', 'sent'] })
  await sync.apply([cell()], [img()]) // rebuild 成功 → image 失敗 → invalidate
  await sync.apply([cell()], [img()])
  expect(calls.map((c) => c.kind)).toEqual(['rebuild', 'image', 'rebuild', 'image'])
})

test('image: 幾何の変化は topo 変化として rebuild させる', async () => {
  const { sync, calls } = harness()
  await sync.apply([cell()], [img()])
  await sync.apply([cell()], [img({ width: 144 })])
  expect(calls.map((c) => c.kind)).toEqual(['rebuild', 'image', 'rebuild', 'image'])
})

test('seed: 画像実体は未送信扱い (起動時は placeholder) → 最初の apply で送る', async () => {
  const { sync, calls } = harness()
  sync.seed([cell()], [img()])
  await sync.apply([cell()], [img()])
  expect(calls).toEqual([{ kind: 'image', detail: 'img1' }])
})

test("image: 'skip' (描画不能) は applied にせず invalidate もしない → 次の apply で再試行", async () => {
  const { sync, calls } = harness({ image: ['skip', 'sent'] })
  await sync.apply([cell()], [img()]) // rebuild + skip
  await sync.apply([cell()], [img()]) // 再試行 → sent
  await sync.apply([cell()], [img()]) // applied 済 → 無送信
  expect(calls.map((c) => c.kind)).toEqual(['rebuild', 'image', 'image'])
})
