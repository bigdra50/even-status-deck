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

// ── fullscreen エディタ: 左右クラスタの配置/ドラッグ (実機グラスと同じ左右詰め) ──
// ゾーンを内容幅 (flex:0 0 auto) にし 50/50 強制をやめたので、左クラスタが中央を越えて
// 右 chip の上に重なりドラッグを奪う旧不具合 (#77 の band-aid が対象にしていた状態) が
// 原理的に消えた。flexbox はアイテムを順次配置するため左右クラスタは決して重ならない。
const G2_ETA = 'builtin.local|g2|eta'

type Box = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }

const mid = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

// 矩形が重なっているか (tol ぶんの接触は許容)。portrait では stage が 90° 回転し主軸が
// 画面 Y になるため、軸を固定せず 2D の交差で判定する。
function rectsOverlap(a: Box, b: Box, tol = 2): boolean {
  return (
    a.x < b.x + b.width - tol &&
    b.x < a.x + a.width - tol &&
    a.y < b.y + b.height - tol &&
    b.y < a.y + a.height - tol
  )
}

async function openFsEditor(page: Page): Promise<void> {
  await page.locator('[data-action="fs-open"]').click()
  await expect(page.locator('.fs-root .fs-stage')).toBeVisible()
}

async function box(page: Page, sel: string): Promise<Box> {
  const b = await page.locator(sel).first().boundingBox()
  if (!b) throw new Error(`not measurable: ${sel}`)
  return b
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

// segKey のチップを、指定 row の left/right ゾーンへ drop する。
async function dropToZone(
  page: Page,
  segkey: string,
  row: string,
  side: 'left' | 'right',
): Promise<void> {
  const from = mid(await box(page, `.fs-zone .fs-chip[data-segkey="${segkey}"]`))
  const to = mid(await box(page, `[data-row="${row}"][data-zone="${side}"]`))
  await fsDrag(page, from, to)
}

// segKey が今いるゾーンの data-row を返す。
async function rowOf(page: Page, segkey: string): Promise<string> {
  const z = page.locator(`.fs-zone:has(.fs-chip[data-segkey="${segkey}"])`)
  await expect(z).toBeVisible()
  return (await z.getAttribute('data-row')) ?? ''
}

test('fullscreen editor: a placed chip can be dragged to another row', async ({ page }) => {
  await openFsEditor(page)
  await fsDrag(
    page,
    mid(await box(page, `.fs-zone .fs-chip[data-segkey="${G2_ETA}"]`)),
    mid(await box(page, '[data-row="6"][data-zone="left"]')),
  )
  await expect(
    page.locator(`[data-row="6"][data-zone="left"] .fs-chip[data-segkey="${G2_ETA}"]`),
  ).toHaveCount(1)
})

test('fullscreen editor: × unplaces a chip to the tray', async ({ page }) => {
  await openFsEditor(page)
  const x = await box(page, `.fs-zone .fs-chip[data-segkey="${G2_ETA}"] .fs-x`)
  await page.mouse.click(x.x + x.width / 2, x.y + x.height / 2)
  await expect(page.locator(`.fs-tray .fs-chip[data-segkey="${G2_ETA}"]`)).toHaveCount(1)
  await expect(page.locator(`.fs-zone .fs-chip[data-segkey="${G2_ETA}"]`)).toHaveCount(0)
})

test('fullscreen editor: dropping a chip on a row right side joins the right cluster', async ({
  page,
}) => {
  await openFsEditor(page)
  const row = await rowOf(page, G2_ETA) // g2 クラスタの行
  await dropToZone(page, `${key('mem')}|used`, row, 'right')
  await expect(
    page.locator(
      `[data-row="${row}"][data-zone="right"] .fs-chip[data-segkey="${key('mem')}|used"]`,
    ),
  ).toHaveCount(1)
})

// 回帰: 左右両方に要素がある行で、左クラスタの右端 chip が右 chip に覆われず掴める。
test('fullscreen editor: left and right clusters never overlap; left stays grabbable', async ({
  page,
}) => {
  await openFsEditor(page)
  const row = await rowOf(page, G2_ETA)
  // 同じ行を 左=g2 クラスタ / 右=cpu+mem で埋めて over-full 気味にする。
  await dropToZone(page, `${key('cpu')}|usage`, row, 'right')
  await dropToZone(page, `${key('mem')}|used`, row, 'right')
  // 左クラスタの右端 chip (eta) は右クラスタの chip と重ならない (flexbox は順次配置)。
  const left = await box(
    page,
    `[data-row="${row}"][data-zone="left"] .fs-chip[data-segkey="${G2_ETA}"]`,
  )
  const right = await box(
    page,
    `[data-row="${row}"][data-zone="right"] .fs-chip[data-segkey="${key('cpu')}|usage"]`,
  )
  expect(rectsOverlap(left, right), 'left cluster chip overlaps the right cluster').toBe(false)
  // 覆われていないので別行へドラッグできる。
  await fsDrag(page, mid(left), mid(await box(page, '[data-row="8"][data-zone="left"]')))
  await expect(
    page.locator(`[data-row="8"][data-zone="left"] .fs-chip[data-segkey="${G2_ETA}"]`),
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
