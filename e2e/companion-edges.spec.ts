import { expect, test } from '@playwright/test'
import { attachConsoleErrors, key, MACHINE, openSourceDetail, SERVER_ID, STATUS } from './fixtures'

// companion.ts 分割リファクタの characterization テスト。既存 spec が触れていない
// 周縁領域 (fullscreen エディタ / デバッグコンソール / geofence 連動 / 表示条件エディタ) の
// 最小経路を固定し、機械的移動での回帰を検知する。挙動仕様の正本ではなく現状の写し。

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

// ── fullscreen エディタ (fs-*) ──
test('fullscreen editor opens, Done closes it and keeps the page deck', async ({ page }) => {
  await page.locator('[data-action="fs-open"]').click()
  await expect(page.locator('.fs-root .fs-stage')).toBeVisible()
  await expect(page.locator('.fs-root .fs-bar .fs-title')).toBeVisible()
  await page.locator('.fs-root [data-action="fs-done"]').click()
  await expect(page.locator('.fs-root')).toHaveCount(0)
  // fs-open は auto デッキから explicit 1 ページを生成する → Done 後も page tab が残る
  await expect(page.locator('.page-tab[data-action="page-select"]')).toHaveCount(1)
  await expect(page.locator('.gpv-screen')).toBeVisible()
})

// ── デバッグコンソール (console-*) ──
test('debug console toggles open, captures logs, clears, and collapses', async ({ page }) => {
  await page.locator('[data-action="console-toggle"]').click()
  await expect(page.locator('#dbg-list')).toBeVisible()
  await page.evaluate(() => console.log('edge-marker-123'))
  await expect(page.locator('#dbg-list')).toContainText('edge-marker-123')
  await page.locator('[data-action="console-clear"]').click()
  await expect(page.locator('#dbg-list')).not.toContainText('edge-marker-123')
  await expect(page.locator('#dbg-list')).toContainText('No logs')
  await page.locator('[data-action="console-toggle"]').click()
  await expect(page.locator('#dbg-list')).toHaveCount(0)
})

// ── geofence 連動 (places + profile-geofence-*) ──
test.describe('geofence binding', () => {
  test.use({ geolocation: { latitude: 35.681, longitude: 139.767 }, permissions: ['geolocation'] })

  test('saving a place enables geofence bind and the binding persists', async ({ page }) => {
    // Places 画面で現在地を保存 (prompt は地点名)
    await page.locator('[data-action="manage-places"]').click()
    page.once('dialog', (d) => void d.accept('Edge Home'))
    await page.locator('[data-action="add-current-place"]').click()
    await expect(page.locator('.src-name', { hasText: 'Edge Home' })).toBeVisible()
    await expect(page.locator('[data-action="delete-place"]')).toHaveCount(1)

    // Home へ戻ると保存地点があるので geofence UI が出る
    await page.locator('[data-action="home"]').click()
    const placeSel = page.locator('[data-action="profile-geofence-place"]')
    await expect(placeSel).toBeVisible()
    const modeSel = page.locator('[data-action="profile-geofence-mode"]')
    await expect(modeSel).toBeDisabled() // 未連動時は mode 選択不可
    await placeSel.selectOption({ label: 'Edge Home' })
    await expect(page.locator('[data-action="profile-geofence-mode"]')).toBeEnabled()

    // mode 変更で config-changed が発火し、再描画後も binding が保持される
    // (bridge 不在の e2e 環境では saveConfig はメモリ保持のみ。reload 永続化は対象外)
    const configChanged = page.evaluate(
      () =>
        new Promise<void>((res) =>
          window.addEventListener('toolbar:config-changed', () => res(), { once: true }),
        ),
    )
    await page.locator('[data-action="profile-geofence-mode"]').selectOption('auto')
    await configChanged
    await expect(page.locator('[data-action="profile-geofence-mode"]')).toHaveValue('auto')
  })
})

// ── 表示条件エディタ (seg-vis-*) ──
test('segment visibility condition: add, edit params, remove', async ({ page }) => {
  await openSourceDetail(page, SERVER_ID)
  await page.locator(`.src-caret[data-action="expand"][data-key="${key('cpu')}"]`).click()
  const seg = `[data-key="${key('cpu')}"][data-seg="usage"]`

  // 追加: usage は percent を持つので threshold 既定 (op=gte, value=80)
  await page.locator(`[data-action="seg-vis-add"]${seg}`).click()
  await expect(page.locator('.vis-cond-row')).toHaveCount(1)
  await expect(page.locator(`[data-action="seg-vis-leaf-kind"]${seg}`)).toHaveValue('threshold')
  const valInput = page.locator(`[data-action="seg-vis-leaf-value"]${seg}`)
  await expect(valInput).toHaveValue('80')

  // 編集: 値と比較演算子の変更が再描画後も保持される (= config へ保存された)
  await valInput.fill('55')
  await valInput.dispatchEvent('change')
  await expect(page.locator(`[data-action="seg-vis-leaf-value"]${seg}`)).toHaveValue('55')
  await page.locator(`[data-action="seg-vis-leaf-op"]${seg}`).selectOption('lte')
  await expect(page.locator(`[data-action="seg-vis-leaf-op"]${seg}`)).toHaveValue('lte')

  // 条件があるときだけ Present (提示先) 行が出る
  await expect(page.locator(`[data-action="seg-vis-display-ui"]${seg}`)).toBeVisible()

  // 削除: 行が消えて always 表示へ戻る
  await page.locator(`[data-action="seg-vis-remove"]${seg}`).click()
  await expect(page.locator('.vis-cond-row')).toHaveCount(0)
  await expect(page.locator('.vis-always').first()).toHaveText('always')
})

test('segment visibility condition: leaf-kind switch and toast display params', async ({
  page,
}) => {
  await openSourceDetail(page, SERVER_ID)
  await page.locator(`.src-caret[data-action="expand"][data-key="${key('cpu')}"]`).click()
  const seg = `[data-key="${key('cpu')}"][data-seg="usage"]`
  await page.locator(`[data-action="seg-vis-add"]${seg}`).click()

  // kind 切替: threshold → On update (onChange)。params が op/value から hold(秒) に変わる
  await page.locator(`[data-action="seg-vis-leaf-kind"]${seg}`).selectOption('onChange')
  await expect(page.locator(`[data-action="seg-vis-leaf-kind"]${seg}`)).toHaveValue('onChange')
  await expect(page.locator(`[data-action="seg-vis-leaf-op"]${seg}`)).toHaveCount(0)
  const hold = page.locator(`[data-action="seg-vis-leaf-hold"]${seg}`)
  await expect(hold).toBeVisible()
  await hold.fill('9')
  await hold.dispatchEvent('change')
  await expect(page.locator(`[data-action="seg-vis-leaf-hold"]${seg}`)).toHaveValue('9')

  // 提示先を Toast にすると secs / text フィールドが現れ、設定値が再描画後も保持される
  await page.locator(`[data-action="seg-vis-display-ui"]${seg}`).selectOption('toast')
  const secs = page.locator(`[data-action="seg-vis-display-secs"]${seg}`)
  await expect(secs).toBeVisible()
  await secs.fill('7')
  await secs.dispatchEvent('change')
  await expect(page.locator(`[data-action="seg-vis-display-secs"]${seg}`)).toHaveValue('7')
  const text = page.locator(`[data-action="seg-vis-display-text"]${seg}`)
  await text.fill('cpu hot')
  await text.dispatchEvent('change')
  await expect(page.locator(`[data-action="seg-vis-display-text"]${seg}`)).toHaveValue('cpu hot')

  // Inline へ戻すと display は削除され secs/text が消える
  await page.locator(`[data-action="seg-vis-display-ui"]${seg}`).selectOption('')
  await expect(page.locator(`[data-action="seg-vis-display-secs"]${seg}`)).toHaveCount(0)
})
