import { expect, test } from '@playwright/test'
import { attachConsoleErrors, MACHINE, STATUS } from './fixtures'

// 既定サーバ (server.local) の preset 内 Sources 行の接続ドット。
const DOT = '.src:has([data-action="remove-from-preset"][data-src="server.local"]) .conn-dot'

// 切断検出の回帰テスト。retry backoff (10/20/40s) と 60s poll を page.clock で早送りし、
// online → stale → offline → 復帰、および glass preview からの offline group 除外を検証する。
test.describe('disconnect detection', () => {
  test('online → stale → offline → recover, glass drops the offline group', async ({ page }) => {
    const errors = attachConsoleErrors(page)
    await page.clock.install()

    let down = false
    await page.route('**/api/status', (r) =>
      down ? r.fulfill({ status: 503, body: 'down' }) : r.fulfill({ json: STATUS }),
    )
    await page.route('**/api/machine', (r) => r.fulfill({ json: MACHINE }))

    await page.goto('/')
    await expect(page.locator('#source-list .src-name', { hasText: 'CPU' })).toBeVisible()

    const dot = page.locator(DOT)
    const glass = page.locator('.glass-screen')

    // online: ドットに off/stale クラスなし、glass preview に CPU 値あり。
    await expect(dot).not.toHaveClass(/\b(off|stale)\b/)
    await expect(glass).toContainText('46%')

    // サーバ停止 → 次の poll(60s) で stale。glass は値を維持 (瞬断吸収)。
    down = true
    await page.clock.fastForward(61_000)
    await expect(dot).toHaveClass(/\bstale\b/)
    await expect(glass).toContainText('46%')

    // retry(10/20/40s) + 後続 poll が全滅 → offline。fake 時間を刻みつつ
    // 実時間 wait を挟み、失敗 fetch の解決と次 retry のスケジュールを進める。
    for (let i = 0; i < 10; i++) {
      await page.clock.fastForward(30_000)
      await page.waitForTimeout(40)
    }
    await expect(dot).toHaveClass(/\boff\b/)
    await expect(page.locator('.src-note', { hasText: /Last seen/ })).toBeVisible()
    // offline source の group は glass preview から除外される (古い値=嘘を出さない)。
    await expect(glass).not.toContainText('46%')

    // 復帰: サーバ回復 → 次 poll で online、glass に値が戻る。
    down = false
    await page.clock.fastForward(61_000)
    await expect(dot).not.toHaveClass(/\b(off|stale)\b/)
    await expect(glass).toContainText('46%')

    // 意図的な 503 のネットワークログ (Failed to load resource) は想定内なので除外し、
    // アプリ由来の例外/エラーが無いことのみ保証する。
    const appErrors = errors.filter((e) => !/Failed to load resource/i.test(e))
    expect(appErrors, `console errors:\n${appErrors.join('\n')}`).toHaveLength(0)
  })
})
