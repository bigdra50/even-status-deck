import { expect, type Page, test } from '@playwright/test'
import { attachConsoleErrors, key, MACHINE, openSourceDetail, SERVER_ID, STATUS } from './fixtures'

// companion.ts 分割リファクタの characterization テスト。既存 spec が触れていない
// 周縁領域 (fullscreen エディタ / デバッグコンソール / 表示条件エディタ) の
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

// ── fullscreen エディタ: zone を越えてはみ出したチップのヒットテスト回帰 ──
// 1 zone に複数チップを置くとクラスタは行中央 (zone 境界) を越えてはみ出す。チップが
// positioned (.fs-glass .fs-chip) でないと DOM 上で後の .fs-zone-r が pointerdown/click を
// 奪い、はみ出したチップを掴めず × も効かない。既定レイアウトでは g2 group の 3 チップ目
// (eta) がこの状態を再現する (前提が崩れたら overflowGrabPoint の expect で検知する)。
const ETA_CHIP = 'builtin.local|g2|eta'

type Box = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }

// チップが zone ボックスの外へはみ出した部分の中心点。portrait 回転下では行方向が y になる
// ため軸非依存で判定する。はみ出していなければ null。
function overflowMid(chip: Box, zone: Box): Point | null {
  const yEnd = zone.y + zone.height
  if (chip.y + chip.height > yEnd + 8)
    return { x: chip.x + chip.width / 2, y: (Math.max(chip.y, yEnd) + chip.y + chip.height) / 2 }
  const xEnd = zone.x + zone.width
  if (chip.x + chip.width > xEnd + 8)
    return { x: (Math.max(chip.x, xEnd) + chip.x + chip.width) / 2, y: chip.y + chip.height / 2 }
  return null
}

async function openFsEditor(page: Page): Promise<void> {
  await page.locator('[data-action="fs-open"]').click()
  await expect(page.locator('.fs-root .fs-stage')).toBeVisible()
}

// preview チップのドラッグ。pointerdown 後に移動しきい値 (FS_MOVE_CANCEL_PX=10) を超える
// move で長押しを待たず即 arm し、目的地で drop する。
async function fsDrag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
}

// はみ出しチップ (ETA_CHIP) の zone 外の掴み点と所属 row を返す。
async function overflowGrabPoint(page: Page): Promise<{ point: Point; row: string }> {
  const chip = page.locator(`.fs-zone .fs-chip[data-segkey="${ETA_CHIP}"]`)
  const zone = page.locator(`.fs-zone:has(.fs-chip[data-segkey="${ETA_CHIP}"])`)
  await expect(chip).toBeVisible()
  const chipBox = await chip.boundingBox()
  const zoneBox = await zone.boundingBox()
  if (!chipBox || !zoneBox) throw new Error('eta chip / zone not measurable')
  const point = overflowMid(chipBox, zoneBox)
  expect(point, 'premise: default layout overflows the g2 cluster past its zone').not.toBeNull()
  if (!point) throw new Error('unreachable')
  const row = (await zone.getAttribute('data-row')) ?? ''
  return { point, row }
}

test('fullscreen editor: chip overflowing past the zone can still be dragged', async ({ page }) => {
  await openFsEditor(page)
  const { point } = await overflowGrabPoint(page)
  const target = page.locator('[data-row="5"][data-zone="left"]')
  const tb = await target.boundingBox()
  if (!tb) throw new Error('row5 left zone not measurable')
  await fsDrag(page, point, { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 })
  await expect(
    page.locator(`[data-row="5"][data-zone="left"] .fs-chip[data-segkey="${ETA_CHIP}"]`),
  ).toHaveCount(1)
})

test('fullscreen editor: unplace (×) works on a chip overflowing past the zone', async ({
  page,
}) => {
  await openFsEditor(page)
  await overflowGrabPoint(page) // はみ出し前提の確認
  const x = page.locator(`.fs-zone .fs-chip[data-segkey="${ETA_CHIP}"] .fs-x`)
  const xb = await x.boundingBox()
  if (!xb) throw new Error('fs-x not measurable')
  await page.mouse.click(xb.x + xb.width / 2, xb.y + xb.height / 2)
  await expect(page.locator(`.fs-tray .fs-chip[data-segkey="${ETA_CHIP}"]`)).toHaveCount(1)
  await expect(page.locator(`.fs-zone .fs-chip[data-segkey="${ETA_CHIP}"]`)).toHaveCount(0)
})

test('fullscreen editor: drop on an overflowed chip resolves to the geometric half', async ({
  page,
}) => {
  await openFsEditor(page)
  const { point, row } = await overflowGrabPoint(page)
  // zone 内に収まっている mem チップを、はみ出し領域 (右半分) へ drop すると、
  // 下にあるチップの所属クラスタではなく幾何学的な半分 = 右クラスタへ入る
  const memChip = page.locator(`.fs-zone .fs-chip[data-segkey="${key('mem')}|used"]`)
  const mb = await memChip.boundingBox()
  if (!mb) throw new Error('mem chip not measurable')
  await fsDrag(page, { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 }, point)
  await expect(
    page.locator(
      `[data-row="${row}"][data-zone="right"] .fs-chip[data-segkey="${key('mem')}|used"]`,
    ),
  ).toHaveCount(1)
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
