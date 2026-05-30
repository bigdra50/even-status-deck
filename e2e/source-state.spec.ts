import { expect, test } from '@playwright/test'
import { attachConsoleErrors, MACHINE, STATUS } from './fixtures'

// 既定サーバ (server.local) の preset 内 Sources 行の接続ドット。
const DOT = '.src:has([data-action="remove-from-preset"][data-src="server.local"]) .conn-dot'

// ソース報告の degraded state (PROTOCOL §3) の回帰テスト。transport は 200 (online) のまま
// StatusDoc に group.state="error" を載せ、conn-dot が琥珀 + message を出すこと、
// 値据え置きの state 変化でも再描画されること (statusSig に state を含む) を検証する。
test.describe('source-reported degraded state (PROTOCOL §3)', () => {
  test('online but reported error → amber dot + message, recovers when state clears', async ({
    page,
  }) => {
    const errors = attachConsoleErrors(page)
    await page.clock.install()

    let degraded = false
    await page.route('**/api/status', (r) => {
      if (!degraded) return r.fulfill({ json: STATUS })
      // 値は同一のまま group.state だけ error にする (transport は 200)。
      const doc = structuredClone(STATUS)
      doc.groups[0].state = 'error'
      doc.groups[0].message = 'usage API unavailable'
      return r.fulfill({ json: doc })
    })
    await page.route('**/api/machine', (r) => r.fulfill({ json: MACHINE }))

    await page.goto('/')
    await expect(page.locator('#source-list .src-name', { hasText: 'CPU' })).toBeVisible()

    const dot = page.locator(DOT)
    const glass = page.locator('.glass-screen')

    // online & state ok: ドットに off/stale クラスなし。
    await expect(dot).not.toHaveClass(/\b(off|stale)\b/)

    // transport は online のままソースが error 報告 → 次 poll で琥珀 + message。
    degraded = true
    await page.clock.fastForward(61_000)
    await expect(dot).toHaveClass(/\bstale\b/)
    await expect(page.locator('.src-note', { hasText: 'usage API unavailable' })).toBeVisible()
    // glass は値をそのまま描く (state は別軸。error は値レベルで n/a 符号化する規約)。
    await expect(glass).toContainText('46%')

    // 回復: state が消えれば通常表示へ戻る。
    degraded = false
    await page.clock.fastForward(61_000)
    await expect(dot).not.toHaveClass(/\b(off|stale)\b/)

    expect(errors, `console errors:\n${errors.join('\n')}`).toHaveLength(0)
  })
})
