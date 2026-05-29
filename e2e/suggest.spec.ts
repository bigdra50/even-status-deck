import { expect, type Page, test } from '@playwright/test'
import { MACHINE, STATUS } from './fixtures'

// Phase 4: 接続検出ベースのプリセット切替「提案」(自動適用はしない) の回帰テスト。
// 現アーキは active profile が有効化した source だけを fetch する (DESIGN §4: 非有効 source は
// fetch しない)。よって提案は「縮退提案」: active が有効化している source の一部が online でなく
// なったとき、その死んだ source を抱えない別 profile (= online な source だけを有効化) が現 active
// より厳密に合致するなら提示する。承認で Phase 2 の切替を呼ぶ。
//  1. enabled source の片方が online でなくなると、それを抱えない profile への切替を提案する。
//  2. 承認 (Switch) で active が提案先になりバナーが消える。
//  3. 却下 (×) で当該セッション中は同じ提案を再表示しない (poll が進んでも出ない)。

// machineId 派生 id: localhost -> host-testbox / other.box -> host-otherbox。
const ID_A = 'host-testbox'
const ID_B = 'host-otherbox'
const URL_A = 'http://localhost:5273'
const URL_B = 'http://other.box:9999'

const profileSelect = (p: Page) => p.locator('.profile-select')
const activeProfileName = (p: Page) =>
  profileSelect(p).evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? '')
const banner = (p: Page) => p.locator('.suggest-banner')
const gear = (p: Page, id: string) => p.locator(`[data-action="edit-source"][data-src="${id}"]`)
const urlInput = (p: Page) => p.locator('.field-row input[type="text"]')

async function testConnection(p: Page, url: string): Promise<void> {
  await urlInput(p).fill(url)
  await p.locator('[data-action="test"]').click()
  await expect(p.locator('.status-ok')).toBeVisible()
}

// 2 source を別 profile に振り分け、active (Preset 2) が両方を、Default は片方だけを有効化する状況を作る。
//   - Default : { host-testbox }                 (host-otherbox を抱えない縮退候補)
//   - Preset 2: { host-testbox, host-otherbox }   (active)
// host-otherbox は /api/machine は成功するが /api/status は 503 → 追加直後の fetch で online に
// ならない (stale)。online={host-testbox} に対し Default が active より厳密に合致 → Default を提案。
async function buildScenario(p: Page): Promise<void> {
  // (A) 既定サーバ server.local を localhost で安定化 → host-testbox (online, Default に属する)。
  await gear(p, 'server.local').click()
  await testConnection(p, URL_A)
  await p.locator('[data-action="home"]').click()
  await expect(gear(p, ID_A)).toBeVisible()

  // (B) Preset 2 を追加 (active, enabledSourceIds = 現 source = {builtin, host-testbox} を複製)。
  await p.locator('[data-action="profile-add"]').click()
  await expect.poll(() => activeProfileName(p)).not.toBe('Default')

  // (C) Preset 2 が active のまま 2 台目 (other.box) を追加・接続 → host-otherbox は active だけに属す。
  //     /api/status は 503 なので追加直後の fetch で online にならない。
  await p.locator('[data-action="add-source"]').click()
  await testConnection(p, URL_B)
  await p.locator('[data-action="home"]').click()
  await expect(gear(p, ID_B)).toBeVisible()
}

// このスペックは host-otherbox の /api/status を意図的に 503 にして「online でない source」を
// 作るため、ブラウザが出す "Failed to load resource: 503" の資源ロードエラーは想定内 (アプリ由来の
// エラーではない)。favicon と並べて除外し、アプリ由来のコンソールエラー/例外だけを失敗にする。
function attachAppConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    const text = m.text()
    if (m.type() !== 'error') return
    if (/favicon/i.test(text)) return
    if (/Failed to load resource/i.test(text)) return // 意図的 503 (offline 検出のための偽装)
    errors.push(text)
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

let consoleErrors: string[]

test.beforeEach(async ({ page }) => {
  consoleErrors = attachAppConsoleErrors(page)
  // URL ごとに machineId を出し分ける (合流させず別 source にするため)。
  await page.route('**/api/machine', (r) => {
    const host = new URL(r.request().url()).hostname
    const machineId = host === 'localhost' ? 'testbox' : 'otherbox'
    return r.fulfill({ json: { ...MACHINE, machineId } })
  })
  // localhost は STATUS (online)、other.box は 503 (online にならない)。
  await page.route('**/api/status', (r) => {
    const host = new URL(r.request().url()).hostname
    if (host !== 'localhost') return r.fulfill({ status: 503, body: 'down' })
    return r.fulfill({ json: STATUS })
  })
  await page.goto('/')
  await expect(page.locator('#source-list > .src').first()).toBeVisible()
})

test.afterEach(() => {
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0)
})

test('suggests a narrower preset when an enabled source is not online', async ({ page }) => {
  await buildScenario(page)
  // online={host-testbox} に対し Default ({host-testbox}) が現 active (Preset 2, host-otherbox を
  // 抱える) より厳密に合致する → Default への切替が提案される。
  await expect(banner(page)).toBeVisible()
  await expect(banner(page)).toContainText('Default')
})

test('accepting the suggestion switches preset (Phase 2) and clears the banner', async ({
  page,
}) => {
  await buildScenario(page)
  await expect(banner(page)).toBeVisible()
  await banner(page).locator('[data-action="suggest-accept"]').click()
  // active が提案先 (Default) になり、active が最適になったのでバナーは消える。
  await expect.poll(() => activeProfileName(page)).toBe('Default')
  await expect(banner(page)).toHaveCount(0)
})

test('dismissing the suggestion hides it and does not re-show for the session', async ({
  page,
}) => {
  await buildScenario(page)
  await expect(banner(page)).toBeVisible()
  const before = await activeProfileName(page)
  await banner(page).locator('[data-action="suggest-dismiss"]').click()
  await expect(banner(page)).toHaveCount(0)
  // active は変わらない (却下は手動操作を妨げない)。
  expect(await activeProfileName(page)).toBe(before)

  // poll が複数回進んでも (health 再評価 + 再描画が走っても) 同じ提案は再表示されない。
  await page.clock.install()
  await page.clock.fastForward(61_000)
  await page.clock.fastForward(61_000)
  await expect(banner(page)).toHaveCount(0)
  // dismiss は手動切替も妨げない: select で別 profile に切替えてもエラーなく動く。
  expect(await activeProfileName(page)).toBe(before)
})
