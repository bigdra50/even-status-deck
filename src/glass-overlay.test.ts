// overlay manager の自動消去/キー生成のテスト (純粋状態機械部分。描画は対象外)。
// notification の durationMs 自動消去 (条件提示向け)、手動 notif の温存、toast 期限、content-hash key。
// 実行: bun test src/glass-overlay.test.ts
import { expect, test } from 'bun:test'
import { createOverlayManager } from './glass-overlay'

test('notification: durationMs 指定で tick により自動消去される', () => {
  const ov = createOverlayManager()
  ov.notify({ app: 'A', sender: 'S', body: 'B' }, { durationMs: 5000 })
  expect(ov.isActive()).toBe(true)
  ov.tick(0) // expiresAt を 0+5000 に arm
  expect(ov.nextWakeMs(0)).toBe(5000)
  ov.tick(5000) // 満了 → 除去
  expect(ov.isActive()).toBe(false)
})

test('notification: durationMs 無し(手動 notif)は tick で消えない', () => {
  const ov = createOverlayManager()
  ov.notify({ app: 'A', sender: 'S', body: 'B' }) // 手動 (server 由来想定)
  ov.tick(0)
  ov.tick(100_000)
  expect(ov.isActive()).toBe(true)
  expect(ov.nextWakeMs(0)).toBe(Number.POSITIVE_INFINITY)
})

test('toast: durationMs で tick により自動消去される', () => {
  const ov = createOverlayManager()
  ov.toast('hello', { durationMs: 3000 })
  ov.tick(0) // head.expiresAt = 3000
  expect(ov.nextWakeMs(0)).toBe(3000)
  ov.tick(3000)
  expect(ov.isActive()).toBe(false)
})

test('priority: dialog > notification > toast', () => {
  const ov = createOverlayManager()
  ov.toast('t')
  ov.notify({ app: 'A', sender: 'S', body: 'B' }, { durationMs: 5000 })
  // notification が toast より優先 → notification の期限が nextWake を支配
  expect(ov.nextWakeMs(0)).toBe(0) // 未 arm の notif → 0 (即 tick 要求)
  ov.dialog('T', 'M', ['OK'])
  expect(ov.nextWakeMs(0)).toBe(Number.POSITIVE_INFINITY) // dialog 優先 → 期限なし
})

test('notification: 前方の期限付きが消えても選択中 notif を指し続ける', () => {
  const ov = createOverlayManager()
  ov.notify({ app: 'A', sender: 'a', body: 'timed' }, { durationMs: 3000 }) // idx0 期限付き
  ov.notify({ app: 'B', sender: 'b', body: 'manual1' }) // idx1 手動
  ov.notify({ app: 'C', sender: 'c', body: 'manual2' }) // idx2 手動
  ov.handleScroll(1) // 選択を idx1 (B) へ
  ov.tick(0) // arm A の expiresAt=3000
  ov.tick(3000) // A 満了 → [B, C]。選択は B のまま (idx0) であるべき
  // B を tap で既読にすると C ではなく B が消える (=選択が B を指していた証跡)
  ov.handleTap()
  // 残りは C のみ → containers の本文に manual2 が出る
  const html = ov
    .containers('x\ny\nz')
    .map((c) => c.content ?? '')
    .join(' ')
  expect(html).toContain('manual2')
  expect(html).not.toContain('manual1')
})

test('key(): content-hash なので同長別内容で変わる (banner 値更新を再描画)', () => {
  const ov = createOverlayManager()
  ov.setBanner('AAAA')
  const k1 = ov.key()
  ov.clearBanner()
  ov.setBanner('BBBB') // 同じ文字数・別内容
  const k2 = ov.key()
  expect(k1).not.toBe(k2)
})
