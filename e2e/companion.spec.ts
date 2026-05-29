import { expect, type Page, test } from '@playwright/test'
import { attachConsoleErrors, key, MACHINE, STATUS } from './fixtures'

// caret と name の両方に data-action="expand" が付くため caret に限定する。
const expandBtn = (p: Page, groupId: string) =>
  p.locator(`.src-caret[data-action="expand"][data-key="${key(groupId)}"]`)
const metrics = (p: Page, groupId: string) =>
  p.locator(`.src-metrics[data-key="${key(groupId)}"]`)

// 並べ替え (SortableJS) をマウスで実行する。delayOnTouchOnly:true なのでマウスは遅延なしで
// drag 開始する。SortableJS が反応するよう途中に複数の mousemove を挟む。
async function dragGroupBelow(p: Page, fromGroupId: string, toGroupId: string): Promise<void> {
  const grip = p.locator(`.src[data-key="${key(fromGroupId)}"] .src-grip`)
  const target = p.locator(`.src[data-key="${key(toGroupId)}"]`)
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

const groupTitles = (p: Page) => p.locator('#source-list .src-head .src-name').allInnerTexts()

let consoleErrors: string[]

test.beforeEach(async ({ page }) => {
  consoleErrors = attachConsoleErrors(page)
  await page.route('**/api/status', (r) => r.fulfill({ json: STATUS }))
  await page.route('**/api/machine', (r) => r.fulfill({ json: MACHINE }))
  await page.goto('/')
  await expect(page.locator('#source-list > .src').first()).toBeVisible()
})

// 全テストでコンソールエラー 0 を保証 (フル再描画/fire-and-forget save の回帰ネット)。
test.afterEach(() => {
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0)
})

test('mounts and renders server groups + glass preview', async ({ page }) => {
  await expect(page.locator('#source-list .src-name', { hasText: 'CPU' })).toBeVisible()
  await expect(page.locator('#source-list .src-name', { hasText: 'Memory' })).toBeVisible()
  await expect(page.locator('.gpv-screen')).toBeVisible()
})

test('expand shows metrics, collapse hides them', async ({ page }) => {
  await expect(metrics(page, 'cpu')).toHaveCount(0)
  await expandBtn(page, 'cpu').click()
  await expect(metrics(page, 'cpu')).toBeVisible()
  await expect(metrics(page, 'cpu').locator('.metric')).toHaveCount(2) // usage + load
  await expandBtn(page, 'cpu').click()
  await expect(metrics(page, 'cpu')).toHaveCount(0)
})

test('segment toggle flips immediately (non-blocking render)', async ({ page }) => {
  await expandBtn(page, 'cpu').click()
  const seg = page.locator(
    `[data-action="toggle-seg"][data-key="${key('cpu')}"][data-seg="usage"]`,
  )
  const wasOn = await seg.evaluate((el) => el.classList.contains('on'))
  await seg.click()
  if (wasOn) await expect(seg).not.toHaveClass(/\bon\b/)
  else await expect(seg).toHaveClass(/\bon\b/)
})

test('rapid toggles stay consistent and error-free', async ({ page }) => {
  await expandBtn(page, 'cpu').click()
  const seg = page.locator(
    `[data-action="toggle-seg"][data-key="${key('cpu')}"][data-seg="usage"]`,
  )
  const start = await seg.evaluate((el) => el.classList.contains('on'))
  for (let i = 0; i < 6; i++) await seg.click() // 偶数回 → 元の状態に戻る
  if (start) await expect(seg).toHaveClass(/\bon\b/)
  else await expect(seg).not.toHaveClass(/\bon\b/)
})

test('toggling dispatches config-changed (save path intact)', async ({ page }) => {
  await page.evaluate(() => {
    ;(window as unknown as { __cfg: number }).__cfg = 0
    window.addEventListener('toolbar:config-changed', () => {
      ;(window as unknown as { __cfg: number }).__cfg++
    })
  })
  await page.locator(`[data-action="toggle-group"][data-key="${key('cpu')}"]`).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __cfg: number }).__cfg))
    .toBeGreaterThan(0)
})

test('grips keep touch-action pan-y (scroll-fix regression guard)', async ({ page }) => {
  await expandBtn(page, 'cpu').click()
  const srcGripTA = await page
    .locator('.src-grip')
    .first()
    .evaluate((el) => getComputedStyle(el).touchAction)
  const mgripTA = await page
    .locator('.metric-row .mgrip')
    .first()
    .evaluate((el) => getComputedStyle(el).touchAction)
  expect(srcGripTA).toBe('pan-y')
  expect(mgripTA).toBe('pan-y')
})

test('group reorder via grip drag still works (touch-action does not break drag)', async ({
  page,
}) => {
  const before = await groupTitles(page)
  const cpu0 = before.indexOf('CPU')
  const mem0 = before.indexOf('Memory')
  expect(cpu0).toBeGreaterThanOrEqual(0)
  expect(mem0).toBeGreaterThan(cpu0) // 初期は CPU が Memory より上
  await dragGroupBelow(page, 'cpu', 'mem')
  await expect
    .poll(
      async () => {
        const o = await groupTitles(page)
        return o.indexOf('CPU') > o.indexOf('Memory')
      },
      { timeout: 5_000 },
    )
    .toBe(true)
})

// スクロール不能不具合の layout 回帰ガード。タッチ固有の SortableJS 干渉は desktop では
// 再現できないため、ここでは「全項目展開時に最下部の glass preview まで到達できる」
// レイアウト健全性のみを保証する (タッチ挙動の最終確認は実機 A/B)。
test.describe('scrollability', () => {
  test.use({ viewport: { width: 390, height: 600 } })

  test('glass preview is reachable at the bottom with all items expanded', async ({ page }) => {
    const keys = await page
      .locator('#source-list > .src')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-key')).filter(Boolean) as string[])
    for (const k of keys) {
      await page.locator(`.src-caret[data-action="expand"][data-key="${k}"]`).click()
    }
    const overflows = await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight,
    )
    expect(overflows, 'content should overflow the viewport when all expanded').toBe(true)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const box = await page.locator('.gpv-screen').boundingBox()
    const vh = page.viewportSize()?.height ?? 0
    expect(box).not.toBeNull()
    // 最下部までスクロールしたとき glass preview の上端が viewport 内に入る = 到達可能。
    expect(box?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(vh)
  })
})
