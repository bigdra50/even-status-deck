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
  await expect(page.locator(`#grid-rows .wys-chip[data-segkey="${chipKey}"]`)).toBeVisible()
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

test('shrinking a cell below its rows returns hidden-row chips to the shelf', async ({ page }) => {
  await enterGridMode(page)
  await page.locator('[data-action="grid-cell-add"]').click() // 6×2 = 2 行
  const shelfBefore = await page.locator('.wys-shelf .wys-chip').count()
  // 2 つの chip を別行に置く (grid-chip-add は空行優先)。
  await page.locator('.wys-shelf .wys-chip[data-action="grid-chip-add"]').first().click()
  await page.locator('.wys-shelf .wys-chip[data-action="grid-chip-add"]').first().click()
  await expect(page.locator('.wys-shelf .wys-chip')).toHaveCount(shelfBefore - 2)
  await expect(page.locator('#grid-rows .wys-line')).toHaveCount(2)
  // H− で 1 行に縮小 → 2 行目の chip が棚に戻る。
  await page.locator('[data-action="grid-cell-resize"][data-dim="h"][data-delta="-1"]').click()
  await expect(page.locator('#grid-rows .wys-line')).toHaveCount(1)
  await expect(page.locator('.wys-shelf .wys-chip')).toHaveCount(shelfBefore - 1)
})

test('switching pages clears the cell selection', async ({ page }) => {
  await enterGridMode(page)
  await page.locator('[data-action="grid-cell-add"]').click()
  await expect(page.locator('.grid-cell-sel')).toHaveCount(1)
  await page.locator('[data-action="page-add"]').click() // page2 (rows モード) を作成して移動
  await expect(page.locator('.wys-screen')).toBeVisible()
  await page.locator('.page-tab[data-page-idx="0"]').click() // page1 へ戻る
  await expect(page.locator('.grid-canvas')).toBeVisible()
  await expect(page.locator('.grid-cell-sel')).toHaveCount(0) // 選択は持ち越さない
  await expect(page.locator('.grid-ctl')).toHaveCount(0)
})

test('dragging a chip into the right zone makes it right-aligned (@right)', async ({ page }) => {
  await enterGridMode(page)
  await page.locator('[data-action="grid-cell-add"]').click()
  await page.locator('.wys-shelf .wys-chip[data-action="grid-chip-add"]').first().click()
  const chip = page.locator('#grid-rows [data-zone="left"] .wys-chip').first()
  const chipKey = await chip.getAttribute('data-segkey')
  const grip = chip.locator('.wys-grip')
  const target = page.locator('#grid-rows .wys-line').first().locator('[data-zone="right"]')
  await target.scrollIntoViewIfNeeded()
  const fb = await grip.boundingBox()
  const tb = await target.boundingBox()
  if (!fb || !tb) throw new Error('bounding box not found')
  // SortableJS (delayOnTouchOnly) はマウスなら遅延なしで drag 開始する。
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
  await page.mouse.down()
  await page.mouse.move(fb.x + fb.width / 2 + 10, fb.y + fb.height / 2, { steps: 4 })
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 12 })
  await page.mouse.up()
  // recomputeFromDom が grid セルへ書き戻し、再描画後も右ゾーンに居る。
  await expect(
    page.locator(`#grid-rows [data-zone="right"] .wys-chip[data-segkey="${chipKey}"]`),
  ).toBeVisible()
})
