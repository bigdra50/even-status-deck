import { expect, type Page, test } from '@playwright/test'
import { attachConsoleErrors, MACHINE, SERVER_ID, STATUS } from './fixtures'

// preset ごとの source 単位 ON/OFF (enabledSourceIds) の回帰テスト。
// OFF にした source は fetch されず Items / glass preview から消える (view は保持され再 ON で復活)。
// これが「業務 preset は私用 Mac を fetch しない」を実現する核心 UI。

const sourceToggle = (p: Page) =>
  p.locator(`[data-action="toggle-source"][data-src="${SERVER_ID}"]`)
const itemNames = (p: Page) => p.locator('#source-list .src-name').allInnerTexts()

let consoleErrors: string[]

test.beforeEach(async ({ page }) => {
  consoleErrors = attachConsoleErrors(page)
  await page.route('**/api/status', (r) => r.fulfill({ json: STATUS }))
  await page.route('**/api/machine', (r) => r.fulfill({ json: MACHINE }))
  await page.goto('/')
  await expect(page.locator('#source-list > .src').first()).toBeVisible()
})

test.afterEach(() => {
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0)
})

test('server source has an enable toggle; builtin is not listed in Sources', async ({ page }) => {
  await expect(sourceToggle(page)).toBeVisible()
  // builtin (Device) は Sources に出ない → server source の toggle は 1 個だけ。
  await expect(page.locator('[data-action="toggle-source"]')).toHaveCount(1)
  // 既定は ON。
  await expect(sourceToggle(page)).toHaveClass(/on/)
})

test('turning a source off removes its items; on restores them', async ({ page }) => {
  await expect.poll(() => itemNames(page)).toContain('CPU')

  // OFF: fetch を止め Items / preview から消す。
  await sourceToggle(page).click()
  await expect.poll(() => itemNames(page)).not.toContain('CPU')
  await expect.poll(() => itemNames(page)).not.toContain('Memory')
  await expect(page.locator('.src', { hasText: 'Off in this preset' })).toBeVisible()
  await expect(sourceToggle(page)).not.toHaveClass(/on/)

  // ON: 取得を再開し復活。
  await sourceToggle(page).click()
  await expect.poll(() => itemNames(page)).toContain('CPU')
  await expect.poll(() => itemNames(page)).toContain('Memory')
})

test('source enablement is independent per preset', async ({ page }) => {
  // Default で source を OFF。
  await sourceToggle(page).click()
  await expect.poll(() => itemNames(page)).not.toContain('CPU')

  // 新規 preset (enabledSourceIds = builtin + 全 server なので ON)。
  await page.locator('[data-action="profile-add"]').click()
  await expect.poll(() => itemNames(page)).toContain('CPU')

  // Default へ戻すと OFF のまま = preset ごとに独立。
  await page.locator('.profile-select').selectOption({ label: 'Default' })
  await expect.poll(() => itemNames(page)).not.toContain('CPU')
})
