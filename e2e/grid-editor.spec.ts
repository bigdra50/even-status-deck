// grid ページエディタ (Issue #17): linear⇄grid 切替・セル追加/選択/移動/拡縮・タップでの chip
// 割当・プレビュー反映のフロー。tap-select + stepper 操作 (drag 非依存) なので headless でも安定。
import { expect, type Page, test } from '@playwright/test'
import { attachConsoleErrors, MACHINE, STATUS } from './fixtures'

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

// customize → grid 切替 → セル追加まで進める共通フロー。
async function enterGridMode(page: Page): Promise<void> {
  await page.locator('[data-action="layout-customize"]').click()
  await expect(page.locator('.wys-screen')).toBeVisible()
  await page.locator('[data-action="page-mode-toggle"]').click()
  await expect(page.locator('.grid-canvas')).toBeVisible()
}

test('page-mode-toggle switches between rows editor and grid editor', async ({ page }) => {
  await enterGridMode(page)
  // grid モード: 行エディタは消え、空キャンバス + Add cell。
  await expect(page.locator('.wys-screen')).toHaveCount(0)
  await expect(page.locator('.grid-cell')).toHaveCount(0)
  // rows へ戻すと行エディタ復帰。
  await page.locator('[data-action="page-mode-toggle"]').click()
  await expect(page.locator('.wys-screen')).toBeVisible()
})

test('add cell, select it, move and resize via steppers', async ({ page }) => {
  await enterGridMode(page)
  await page.locator('[data-action="grid-cell-add"]').click()
  const cell = page.locator('.grid-cell')
  await expect(cell).toHaveCount(1)
  await expect(cell).toHaveClass(/grid-cell-sel/) // 追加直後は選択状態
  await expect(page.locator('.grid-ctl-lbl')).toContainText('cell1 — 6×2 @ (0,0)')

  await page.locator('[data-action="grid-cell-move"][data-dx="1"]').click()
  await expect(page.locator('.grid-ctl-lbl')).toContainText('@ (1,0)')
  await page.locator('[data-action="grid-cell-resize"][data-dim="w"][data-delta="-1"]').click()
  await expect(page.locator('.grid-ctl-lbl')).toContainText('5×2')
  // 左上 (0,0) へ戻す移動は可能、範囲外 (col -1) ボタンは disabled になる。
  await page.locator('[data-action="grid-cell-move"][data-dx="-1"]').click()
  await expect(
    page.locator('[data-action="grid-cell-move"][data-dx="-1"][data-dy="0"]'),
  ).toBeDisabled()
})

test('tapping a shelf chip places it into the selected cell and the preview shows it', async ({
  page,
}) => {
  await enterGridMode(page)
  await page.locator('[data-action="grid-cell-add"]').click()
  // 棚の先頭 chip をタップ → セル行に入る (棚の chip は data-action=grid-chip-add を持つ)。
  const shelfChip = page.locator('.wys-shelf .wys-chip[data-action="grid-chip-add"]').first()
  const chipKey = await shelfChip.getAttribute('data-segkey')
  await shelfChip.click()
  await expect(
    page.locator(`#grid-rows .wys-chip[data-segkey="${chipKey}"]`),
  ).toBeVisible()
  // Done でプレビューに戻ると、grid セルとして描画される。
  await page.locator('[data-action="layout-edit-toggle"]').click()
  await expect(page.locator('.gpv-gridscreen .gpv-cell')).toHaveCount(1)
})

test('delete cell returns its chips to the shelf', async ({ page }) => {
  await enterGridMode(page)
  await page.locator('[data-action="grid-cell-add"]').click()
  const shelfBefore = await page.locator('.wys-shelf .wys-chip').count()
  await page.locator('.wys-shelf .wys-chip[data-action="grid-chip-add"]').first().click()
  await expect(page.locator('.wys-shelf .wys-chip')).toHaveCount(shelfBefore - 1)
  await page.locator('[data-action="grid-cell-remove"]').click()
  await expect(page.locator('.grid-cell')).toHaveCount(0)
  await expect(page.locator('.wys-shelf .wys-chip')).toHaveCount(shelfBefore)
})
