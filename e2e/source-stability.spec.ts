import { expect, type Page, test } from '@playwright/test'
import { attachConsoleErrors, MACHINE, STATUS } from './fixtures'

// Phase 3: source 識別の安定化 (machineId 派生 id + urls[] 複数経路) の回帰テスト。
//  1. 接続テストで取得した machineId で id が安定化する (server.local -> host-testbox)。
//  2. 同 machineId の別 url を追加すると 1 source に urls が束ねられ、経路 failover が効く。
//  3. 削除 -> 同一マシン再追加で同じ source に収束し、profile の配置 (glassLayout) が復活する。
// source 実体の管理 (編集/新規/削除) は Sources 一覧画面 (Manage all) に集約された。

const STABLE_ID = 'host-testbox'
const gear = (p: Page, id: string) => p.locator(`[data-action="edit-source"][data-src="${id}"]`)
const urlInput = (p: Page) => p.locator('.field-row input[type="text"]')

const openSources = (p: Page) => p.locator('[data-action="manage-sources"]').click()
const back = (p: Page) => p.locator('[data-action="back"]').click()
const home = (p: Page) => p.locator('[data-action="home"]').click()

// Source Edit 画面で URL を入れて Test し、Connected になるまで待つ。
async function testConnection(p: Page, url: string): Promise<void> {
  await urlInput(p).fill(url)
  await p.locator('[data-action="test"]').click()
  await expect(p.locator('.status-ok')).toBeVisible()
}

// Sources 一覧から既存 source を編集して接続テスト (テスト後は source-edit 画面のまま)。
async function editAndTest(p: Page, id: string, url: string): Promise<void> {
  await openSources(p)
  await gear(p, id).click()
  await testConnection(p, url)
}

// Sources 一覧での server source 数 (edit-source gear の数)。
const sourceCount = (p: Page) => p.locator('[data-action="edit-source"]').count()

let consoleErrors: string[]

test.beforeEach(async ({ page }) => {
  consoleErrors = attachConsoleErrors(page)
  await page.route('**/api/machine', (r) => r.fulfill({ json: MACHINE }))
  // 既定では全 url が STATUS を返す (個別テストで上書きする)。
  await page.route('**/api/status', (r) => r.fulfill({ json: STATUS }))
  await page.goto('/')
  await expect(page.locator('#source-list > .src').first()).toBeVisible()
})

test.afterEach(() => {
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0)
})

test('connection test adopts machineId-derived id (server.local -> host-testbox)', async ({
  page,
}) => {
  await openSources(page)
  // 既定サーバ server.local が Sources 一覧にある。
  await expect(gear(page, 'server.local')).toBeVisible()
  // 編集 -> Test。machineId 'testbox' を採用して id が host-testbox へ安定化する。
  await gear(page, 'server.local').click()
  await testConnection(page, 'http://localhost:5273')
  await back(page) // Sources 一覧へ戻る
  // gear が新 id を指す = id 安定化が profile 参照ごと remap された証拠。
  await expect(gear(page, STABLE_ID)).toBeVisible()
  await expect(gear(page, 'server.local')).toHaveCount(0)
})

test('adding a second url for the same machine merges into one source (urls failover)', async ({
  page,
}) => {
  // server.local を Test して host-testbox に安定化。
  await editAndTest(page, 'server.local', 'http://127.0.0.1:5273') // url A
  await back(page)
  await expect(gear(page, STABLE_ID)).toBeVisible()

  // 同 machineId (testbox) を別 url で追加 -> 既存 host-testbox に urls が束ねられる (新規行は増えない)。
  const before = await sourceCount(page)
  await page.locator('[data-action="new-source"]').click()
  await testConnection(page, 'http://localhost:5273') // url B (同 machine)
  await back(page)
  await expect(gear(page, STABLE_ID)).toBeVisible()
  const after = await sourceCount(page)
  expect(after).toBe(before) // 合流したので server source 数は不変

  await home(page)
  // failover: url A (先頭) を 503 にし B だけ生かす。次 poll で B に failover して glass に値が残る。
  await page.unroute('**/api/status')
  await page.route('**/api/status', (r) => {
    const u = new URL(r.request().url())
    if (u.hostname === '127.0.0.1') return r.fulfill({ status: 503, body: 'down' })
    return r.fulfill({ json: STATUS })
  })
  await page.clock.install()
  await page.clock.fastForward(61_000) // 次 poll
  await expect(page.locator('.glass-screen')).toContainText('46%')
})

test('failover learning survives a profile switch (no flicker, no reset to dead route)', async ({
  page,
}) => {
  // 回帰: preferUrl が failover 成功経路を in-memory urls 先頭へ寄せた後 (config [A,B] → [B,A])、
  // profile 切替で setSourcesFromConfig が走ると、順序依存 diff だと「経路変更」と誤検知し
  // failCount/lastSuccessAt/retry を破棄 + 落ちている A から再 fetch → glass がちらつき failover
  // 学習がリセットされていた。順序非依存 diff にしたので、同一 url 集合なら鮮度を保持する。
  await editAndTest(page, 'server.local', 'http://127.0.0.1:5273') // url A
  await back(page)
  await page.locator('[data-action="new-source"]').click()
  await testConnection(page, 'http://localhost:5273') // url B (同 machine, 合流)
  await back(page)
  await expect(gear(page, STABLE_ID)).toBeVisible()
  await home(page)

  // url A (先頭) を落とし B だけ生かす。poll で B へ failover し preferUrl が [B,A] へ寄せる。
  await page.unroute('**/api/status')
  let aFetchCount = 0
  await page.route('**/api/status', (r) => {
    const u = new URL(r.request().url())
    if (u.hostname === '127.0.0.1') {
      aFetchCount++
      return r.fulfill({ status: 503, body: 'down' })
    }
    return r.fulfill({ json: STATUS })
  })
  await page.clock.install()
  await page.clock.fastForward(61_000) // 次 poll: A fail → B success → preferUrl [B,A]
  await expect(page.locator('.glass-screen')).toContainText('46%')
  const aFetchesBeforeSwitch = aFetchCount

  // profile を追加して active を切替える (applyProfileChange → setSourcesFromConfig)。
  // 同一 url 集合なので diff は「未変更」と判定し、即時の再 fetch / 鮮度破棄は起きない。
  await page.locator('[data-action="profile-add"]').click()
  await expect(page.locator('.glass-screen')).toContainText('46%')
  expect(aFetchCount).toBe(aFetchesBeforeSwitch)
})

test('merging a configured source into the same machine keeps its placed layout', async ({
  page,
}) => {
  // 「設定済み source を別マシン URL でテストして合流した」ケース。合流元 (editing) が view を
  // 持っていても、合流先 (merged) へ統合され配置が消えないことを検証する (data-destruction 回帰)。
  const OTHER_ID = 'host-otherbox'
  await page.unroute('**/api/machine')
  await page.route('**/api/machine', (r) => {
    const host = new URL(r.request().url()).hostname
    const machineId = host === 'localhost' ? 'testbox' : 'otherbox'
    return r.fulfill({ json: { ...MACHINE, machineId } })
  })

  const memKeyA = `${STABLE_ID}|mem|used`
  const memKeyB = `${OTHER_ID}|mem|used`
  const placed = (segkey: string) => page.locator(`.wys-screen .wys-chip[data-segkey="${segkey}"]`)

  // (A) server.local を testbox で安定化 (host-testbox)。
  await editAndTest(page, 'server.local', 'http://localhost:5273')
  await back(page)
  await expect(gear(page, STABLE_ID)).toBeVisible()

  // (B) 別 source を追加し otherbox で安定化 (host-otherbox)。
  await page.locator('[data-action="new-source"]').click()
  await testConnection(page, 'http://other.box:9999')
  await back(page)
  await expect(gear(page, OTHER_ID)).toBeVisible()
  await home(page)

  // layout を Customize -> 両 source の CPU/Memory が 1 group=1 行で配置される。
  await page.locator('[data-action="layout-customize"]').click()
  await expect(page.locator('.wys-screen')).toBeVisible()
  await expect(placed(memKeyA)).toHaveCount(1) // A の Memory が行に乗る
  await expect(placed(memKeyB)).toHaveCount(1) // B の Memory が行に乗る
  // A 側の Memory chip だけ外す (= 合流時に B 側の Memory 配置が生き残るか検証するため)。
  await placed(memKeyA).locator('[data-action="layout-item-remove"]').click()
  await expect(placed(memKeyA)).toHaveCount(0)
  await page.locator('[data-action="layout-edit-toggle"]').click() // Done

  // (C) B を testbox URL でテスト -> machineId が一致し host-testbox (A) へ合流する。
  await editAndTest(page, OTHER_ID, 'http://localhost:5273')
  await back(page)
  await expect(gear(page, STABLE_ID)).toBeVisible()
  await expect(gear(page, OTHER_ID)).toHaveCount(0) // 合流したので host-otherbox は消える
  await home(page)

  // 合流後、A が外していた Memory 配置が B 由来で復活している (host-testbox|mem|used が行に乗る)。
  await page.locator('[data-action="layout-edit-toggle"]').click() // Edit layout
  await expect(page.locator('.wys-screen')).toBeVisible()
  await expect(placed(memKeyA)).toHaveCount(1)
  await expect(page.locator(`.wys-chip[data-segkey^="${OTHER_ID}|"]`)).toHaveCount(0)
})

test('non-compliant server (machineId 欠落) では合流せず独立 source を保つ', async ({ page }) => {
  // /api/machine が machineId を省いた ({}) サーバを 2 台テストしても、空 machineId 同士が
  // 一致して 1 source に潰れる誤合流 (= 配置/可視性のデータ破壊) を起こさないことを検証する。
  await page.unroute('**/api/machine')
  await page.route('**/api/machine', (r) => r.fulfill({ json: {} })) // machineId 欠落

  // 既定サーバ server.local を非準拠サーバでテスト -> 接続失敗扱い。id は安定化しない。
  await openSources(page)
  await gear(page, 'server.local').click()
  await urlInput(page).fill('http://localhost:5273')
  await page.locator('[data-action="test"]').click()
  await expect(page.locator('.status-err')).toBeVisible() // Connected にならない
  await expect(page.locator('.status-ok')).toHaveCount(0)
  await back(page)

  // server.local のまま (host-... へ remap されていない = 誤った id 安定化が起きていない)。
  await expect(gear(page, 'server.local')).toBeVisible()
  await expect(gear(page, STABLE_ID)).toHaveCount(0)

  // 2 台目を非準拠サーバで追加してテスト -> やはり失敗扱いで、1 台目に合流しない。
  const before = await sourceCount(page)
  await page.locator('[data-action="new-source"]').click()
  await urlInput(page).fill('http://other.box:9999')
  await page.locator('[data-action="test"]').click()
  await expect(page.locator('.status-err')).toBeVisible()
  await back(page)
  const after = await sourceCount(page)
  // 新規 source が独立した行として残る (空 machineId 同士で 1 source に潰れていない)。
  expect(after).toBe(before + 1)
})

test('remove then re-add the same machine restores the glass layout', async ({ page }) => {
  // host-testbox に安定化し、glass layout を Customize (group=1行で生成) する。
  await editAndTest(page, 'server.local', 'http://localhost:5273')
  await back(page)
  await expect(gear(page, STABLE_ID)).toBeVisible()
  await home(page)

  // Glass を Customize -> glassLayout 生成 (CPU/Memory が行に乗る)。Done で編集終了。
  await page.locator('[data-action="layout-customize"]').click()
  await expect(page.locator('.wys-screen')).toBeVisible()
  const cpuChip = `.wys-chip[data-segkey^="${STABLE_ID}|cpu|"]`
  await expect(page.locator(cpuChip).first()).toBeVisible()
  await page.locator('[data-action="layout-edit-toggle"]').click() // Done

  // 削除する (tombstone に host-testbox の view が退避される)。
  await openSources(page)
  await gear(page, STABLE_ID).click()
  page.once('dialog', (d) => d.accept())
  await page.locator('[data-action="delete-source"]').click()
  await expect(gear(page, STABLE_ID)).toHaveCount(0)

  // 同一マシンを再追加 -> 同じ host-testbox に収束し glassLayout が復活する。
  await page.locator('[data-action="new-source"]').click()
  await testConnection(page, 'http://localhost:5273')
  await back(page)
  await expect(gear(page, STABLE_ID)).toBeVisible()
  await home(page)
  // Customize し直さずとも glassLayout が残っている = tombstone から復元された。
  await page.locator('[data-action="layout-edit-toggle"]').click()
  await expect(page.locator('.wys-screen')).toBeVisible()
  await expect(page.locator(cpuChip).first()).toBeVisible()
})
