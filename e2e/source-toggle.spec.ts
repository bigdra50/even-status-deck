import { expect, type Page, test } from '@playwright/test'
import { attachConsoleErrors, MACHINE, SERVER_ID, STATUS, swipeRemoveFromPreset } from './fixtures'

// preset への source 追加/除外 (enabledSourceIds) の回帰テスト。
// preset に含まれない source は preset 画面に出さない (Remove で外す / Add で足す)。
// source 実体は共有され Sources 一覧に残る。これが「業務 preset に私用 Mac を出さない」の核心。

const itemNames = (p: Page) => p.locator('#source-list .src-name').allInnerTexts()
const removeBtn = (p: Page) => p.locator('[data-action="remove-from-preset"]')

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

test('preset lists added server sources with a Remove action; builtin is not listed', async ({
  page,
}) => {
  // server source は preset の Sources に出る (Remove 付き)。builtin(Device) は Sources に出ない。
  await expect(removeBtn(page)).toHaveCount(1)
})

test('removing a source from the preset hides its items; adding it back restores them', async ({
  page,
}) => {
  await expect.poll(() => itemNames(page)).toContain('CPU')

  // preset から外す (swipe→🗑) -> fetch 停止 + Items/glass から消え、preset の Sources からも消える。
  await swipeRemoveFromPreset(page, SERVER_ID)
  await expect.poll(() => itemNames(page)).not.toContain('CPU')
  await expect.poll(() => itemNames(page)).not.toContain('Memory')
  await expect(removeBtn(page)).toHaveCount(0)

  // Add source 画面で既存プールから追加 -> 復活。
  await page.locator('[data-action="open-add-source"]').click()
  // server source を明示指定で戻す。.first() は候補順 (client.weather が先) に依存して
  // 別ソースを掴むため脆い (回帰: source-toggle:32)。
  await page.locator(`[data-action="add-to-preset"][data-src="${SERVER_ID}"]`).click()
  await expect.poll(() => itemNames(page)).toContain('CPU')
})

test('source membership is independent per preset', async ({ page }) => {
  // Default で source を外す (swipe→🗑)。
  await swipeRemoveFromPreset(page, SERVER_ID)
  await expect.poll(() => itemNames(page)).not.toContain('CPU')

  // 新規 preset (addProfile は builtin + 全 server を enabledSourceIds に入れる) -> CPU が出る。
  await page.locator('[data-action="profile-add"]').click()
  await expect.poll(() => itemNames(page)).toContain('CPU')

  // Default へ戻すと外したまま = preset ごとに独立。
  await page.locator('.profile-select').selectOption({ label: 'Default' })
  await expect.poll(() => itemNames(page)).not.toContain('CPU')
})
