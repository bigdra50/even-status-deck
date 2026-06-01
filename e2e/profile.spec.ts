import { expect, type Page, test } from '@playwright/test'
import { attachConsoleErrors, key, MACHINE, STATUS } from './fixtures'

// プリセット (profile) 切替 UI の回帰テスト。Home 最上部の Preset バー (select + 追加/複製/
// リネーム/削除) を操作し、profile ごとに view (並び順/可視性) が独立保持されることを検証する。

const profileSelect = (p: Page) => p.locator('.profile-select')
const activeProfileName = (p: Page) =>
  profileSelect(p).evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? '')
const groupTitles = (p: Page) => p.locator('#source-list .src-head .src-name').allInnerTexts()

// SortableJS のマウスドラッグ (companion.spec と同じ手順)。
async function dragGroupBelow(p: Page, fromGroupId: string, toGroupId: string): Promise<void> {
  const grip = p.locator(`#source-list .src[data-key="${key(fromGroupId)}"] .src-grip`)
  const target = p.locator(`#source-list .src[data-key="${key(toGroupId)}"]`)
  // 新 IA: #source-list は Glass セクション内で fold より下に来るため drag 前に view へ送る。
  await target.scrollIntoViewIfNeeded()
  const fb = await grip.boundingBox()
  const tb = await target.boundingBox()
  if (!fb || !tb) throw new Error('bounding box not found')
  await p.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
  await p.mouse.down()
  await p.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2 + 8, { steps: 4 })
  await p.mouse.move(tb.x + tb.width / 2, tb.y + tb.height - 4, { steps: 12 })
  await p.mouse.move(tb.x + tb.width / 2, tb.y + tb.height + 6, { steps: 4 })
  await p.mouse.up()
}

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

test('renders Preset bar with Default selected, delete disabled', async ({ page }) => {
  await expect(profileSelect(page)).toBeVisible()
  expect(await activeProfileName(page)).toBe('Default')
  // Default は削除不可。
  await expect(page.locator('[data-action="profile-delete"]')).toBeDisabled()
})

test('add creates a new preset and switches to it', async ({ page }) => {
  await page.locator('[data-action="profile-add"]').click()
  // 新規 profile が active になり、option が 2 個になる。
  await expect(profileSelect(page).locator('option')).toHaveCount(2)
  expect(await activeProfileName(page)).not.toBe('Default')
  // Default 以外なので削除可能。
  await expect(page.locator('[data-action="profile-delete"]')).toBeEnabled()
})

test('duplicate clones active preset (independent copy)', async ({ page }) => {
  await page.locator('[data-action="profile-duplicate"]').click()
  await expect(profileSelect(page).locator('option')).toHaveCount(2)
  // 複製名は "<元> copy"。
  expect(await activeProfileName(page)).toBe('Default copy')
})

test('switching presets restores per-preset group order independently', async ({ page }) => {
  // Default で CPU を Memory の下へ並べ替える。
  await expect(page.locator('#source-list .src-name', { hasText: 'CPU' })).toBeVisible()
  const before = await groupTitles(page)
  expect(before.indexOf('CPU')).toBeLessThan(before.indexOf('Memory'))
  await dragGroupBelow(page, 'cpu', 'mem')
  await expect
    .poll(async () => {
      const o = await groupTitles(page)
      return o.indexOf('CPU') > o.indexOf('Memory')
    })
    .toBe(true)

  // 新規 profile を追加 (空 view)。status sync で CPU/Memory が既定順 (CPU が先) に復活する。
  await page.locator('[data-action="profile-add"]').click()
  await expect(page.locator('#source-list .src-name', { hasText: 'CPU' })).toBeVisible()
  await expect
    .poll(async () => {
      const o = await groupTitles(page)
      return o.indexOf('CPU') < o.indexOf('Memory')
    })
    .toBe(true)

  // Default へ戻すと並べ替えた順序 (CPU が後) が保持されている = profile ごとに独立。
  await profileSelect(page).selectOption({ label: 'Default' })
  await expect
    .poll(async () => {
      const o = await groupTitles(page)
      return o.indexOf('CPU') > o.indexOf('Memory')
    })
    .toBe(true)
})

test('rename updates the active preset name', async ({ page }) => {
  page.once('dialog', (d) => d.accept('Work'))
  await page.locator('[data-action="profile-rename"]').click()
  await expect.poll(async () => activeProfileName(page)).toBe('Work')
})

test('delete removes the active preset and falls back to Default', async ({ page }) => {
  await page.locator('[data-action="profile-add"]').click()
  await expect(profileSelect(page).locator('option')).toHaveCount(2)
  expect(await activeProfileName(page)).not.toBe('Default')
  // confirm を承認して削除。
  page.once('dialog', (d) => d.accept())
  await page.locator('[data-action="profile-delete"]').click()
  await expect(profileSelect(page).locator('option')).toHaveCount(1)
  expect(await activeProfileName(page)).toBe('Default')
})

test('preset switch dispatches config-changed (glass propagation)', async ({ page }) => {
  // 追加で 2 個にしておく。
  await page.locator('[data-action="profile-add"]').click()
  await expect(profileSelect(page).locator('option')).toHaveCount(2)
  await page.evaluate(() => {
    ;(window as unknown as { __cfg: number }).__cfg = 0
    window.addEventListener('toolbar:config-changed', () => {
      ;(window as unknown as { __cfg: number }).__cfg++
    })
  })
  // Default へ切替 → config-changed が飛ぶ (glass が view 差し替えで再描画する経路)。
  await profileSelect(page).selectOption({ label: 'Default' })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __cfg: number }).__cfg))
    .toBeGreaterThan(0)
})
