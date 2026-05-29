import { expect, type Page, test } from '@playwright/test'
import { attachConsoleErrors, MACHINE, STATUS } from './fixtures'

// Phase 3: source 識別の安定化 (machineId 派生 id + urls[] 複数経路) の回帰テスト。
//  1. 接続テストで取得した machineId で id が安定化する (server.local -> host-testbox)。
//  2. 同 machineId の別 url を追加すると 1 source に urls が束ねられ、経路 failover が効く。
//  3. 削除 -> 同一マシン再追加で同じ source に収束し、profile の配置 (glassLayout) が復活する。

// MACHINE.machineId = 'testbox' なので派生 id は 'host-testbox' (config.ts deriveSourceId)。
const STABLE_ID = 'host-testbox'
const sourceRow = (p: Page, id: string) =>
  p.locator(`.src:has([data-action="edit-source"][data-src="${id}"])`)
const gear = (p: Page, id: string) => p.locator(`[data-action="edit-source"][data-src="${id}"]`)
const urlInput = (p: Page) => p.locator('.field-row input[type="text"]')

// Source Edit 画面で URL を入れて Test し、Connected になるまで待つ。
async function testConnection(p: Page, url: string): Promise<void> {
  await urlInput(p).fill(url)
  await p.locator('[data-action="test"]').click()
  await expect(p.locator('.status-ok')).toBeVisible()
}

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
  // 既定サーバ server.local が存在する。
  await expect(sourceRow(page, 'server.local')).toBeVisible()
  // 編集 -> Test。machineId 'testbox' を採用して id が host-testbox へ安定化する。
  await gear(page, 'server.local').click()
  await testConnection(page, 'http://localhost:5273')
  await page.locator('[data-action="home"]').click()
  // Sources 行の gear が新 id を指す = id 安定化が profile 参照ごと remap された証拠。
  await expect(gear(page, STABLE_ID)).toBeVisible()
  await expect(gear(page, 'server.local')).toHaveCount(0)
})

test('adding a second url for the same machine merges into one source (urls failover)', async ({
  page,
}) => {
  // server.local を Test して host-testbox に安定化。
  await gear(page, 'server.local').click()
  await testConnection(page, 'http://127.0.0.1:5273') // url A
  await page.locator('[data-action="home"]').click()
  await expect(gear(page, STABLE_ID)).toBeVisible()

  // 同 machineId (testbox) を別 url で追加 -> 既存 host-testbox に urls が束ねられる (新規行は増えない)。
  const rowsBefore = await page
    .locator('#source-list > .src:has([data-action="edit-source"])')
    .count()
  await page.locator('[data-action="add-source"]').click()
  await testConnection(page, 'http://localhost:5273') // url B (同 machine)
  await page.locator('[data-action="home"]').click()
  await expect(gear(page, STABLE_ID)).toBeVisible()
  const rowsAfter = await page
    .locator('#source-list > .src:has([data-action="edit-source"])')
    .count()
  expect(rowsAfter).toBe(rowsBefore) // 合流したので server source 数は不変

  // failover: url A (先頭) を 503 にし B だけ生かす。次 poll で B に failover して glass に値が残る。
  await page.unroute('**/api/status')
  await page.route('**/api/status', (r) => {
    const u = new URL(r.request().url())
    // 127.0.0.1 (url A) は落とす、localhost (url B) は生かす。
    if (u.hostname === '127.0.0.1') return r.fulfill({ status: 503, body: 'down' })
    return r.fulfill({ json: STATUS })
  })
  await page.clock.install()
  await page.clock.fastForward(61_000) // 次 poll
  // 先頭 url が落ちても 2 本目で取得でき、glass preview から値が消えない (= failover 成功)。
  await expect(page.locator('.glass-screen')).toContainText('46%')
})

test('failover learning survives a profile switch (no flicker, no reset to dead route)', async ({
  page,
}) => {
  // 回帰: preferUrl が failover 成功経路を in-memory urls 先頭へ寄せた後 (config [A,B] → [B,A])、
  // profile 切替で setSourcesFromConfig が走ると、順序依存 diff だと「経路変更」と誤検知し
  // failCount/lastSuccessAt/retry を破棄 + 落ちている A から再 fetch → glass がちらつき failover
  // 学習がリセットされていた。順序非依存 diff にしたので、同一 url 集合なら鮮度を保持する。
  await gear(page, 'server.local').click()
  await testConnection(page, 'http://127.0.0.1:5273') // url A
  await page.locator('[data-action="home"]').click()
  await expect(gear(page, STABLE_ID)).toBeVisible()
  await page.locator('[data-action="add-source"]').click()
  await testConnection(page, 'http://localhost:5273') // url B (同 machine, 合流)
  await page.locator('[data-action="home"]').click()
  await expect(gear(page, STABLE_ID)).toBeVisible()

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
  // glass の failover 値が切替直後にちらつかず保持される (offline へ落ちて null 化しない)。
  await expect(page.locator('.glass-screen')).toContainText('46%')
  // 切替で落ちている A への即時再 fetch が発生していない (順序依存 diff なら refreshSource が走った)。
  expect(aFetchCount).toBe(aFetchesBeforeSwitch)
})

test('merging a configured source into the same machine keeps its placed layout', async ({
  page,
}) => {
  // 「設定済み source を別マシン URL でテストして合流した」ケース。合流元 (editing) が view を
  // 持っていても、合流先 (merged) へ統合され配置が消えないことを検証する (data-destruction 回帰)。
  const OTHER_ID = 'host-otherbox'
  // URL ごとに machineId を出し分ける: localhost=testbox / other.box=otherbox。
  await page.unroute('**/api/machine')
  await page.route('**/api/machine', (r) => {
    const host = new URL(r.request().url()).hostname
    const machineId = host === 'localhost' ? 'testbox' : 'otherbox'
    return r.fulfill({ json: { ...MACHINE, machineId } })
  })

  const memKeyA = `${STABLE_ID}|mem|used`
  const memKeyB = `${OTHER_ID}|mem|used`
  // canvas (行) に配置された chip だけを選ぶ (Unplaced 棚の chip と区別する)。
  const placed = (segkey: string) => page.locator(`.wys-screen .wys-chip[data-segkey="${segkey}"]`)

  // (A) server.local を testbox で安定化 (host-testbox)。
  await gear(page, 'server.local').click()
  await testConnection(page, 'http://localhost:5273')
  await page.locator('[data-action="home"]').click()
  await expect(gear(page, STABLE_ID)).toBeVisible()

  // (B) 別 source を追加し otherbox で安定化 (host-otherbox)。
  await page.locator('[data-action="add-source"]').click()
  await testConnection(page, 'http://other.box:9999')
  await page.locator('[data-action="home"]').click()
  await expect(gear(page, OTHER_ID)).toBeVisible()

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
  //     B の view 断片は破棄されず A 側へ統合される。
  await gear(page, OTHER_ID).click()
  await testConnection(page, 'http://localhost:5273')
  await page.locator('[data-action="home"]').click()
  await expect(gear(page, STABLE_ID)).toBeVisible()
  await expect(gear(page, OTHER_ID)).toHaveCount(0) // 合流したので host-otherbox は消える

  // 合流後、A が外していた Memory 配置が B 由来で復活している (host-testbox|mem|used が行に乗る)。
  await page.locator('[data-action="layout-edit-toggle"]').click() // Edit layout
  await expect(page.locator('.wys-screen')).toBeVisible()
  await expect(placed(memKeyA)).toHaveCount(1)
  // 旧 host-otherbox の chip は行にも棚にも残っていない (id が remap された証拠)。
  await expect(page.locator(`.wys-chip[data-segkey^="${OTHER_ID}|"]`)).toHaveCount(0)
})

test('non-compliant server (machineId 欠落) では合流せず独立 source を保つ', async ({ page }) => {
  // /api/machine が machineId を省いた ({}) サーバを 2 台テストしても、空 machineId 同士が
  // 一致して 1 source に潰れる誤合流 (= 配置/可視性のデータ破壊) を起こさないことを検証する。
  // parseMachineInfo が machineId 非空 string でない応答を null にし、reconcile に空を渡さない。
  await page.unroute('**/api/machine')
  await page.route('**/api/machine', (r) => r.fulfill({ json: {} })) // machineId 欠落

  // 既定サーバ server.local を非準拠サーバでテスト -> 接続失敗扱い (machineId 不明)。id は安定化しない。
  await gear(page, 'server.local').click()
  await urlInput(page).fill('http://localhost:5273')
  await page.locator('[data-action="test"]').click()
  await expect(page.locator('.status-err')).toBeVisible() // Connected にならない
  await expect(page.locator('.status-ok')).toHaveCount(0)
  await page.locator('[data-action="home"]').click()

  // server.local のまま (host-... へ remap されていない = 誤った id 安定化が起きていない)。
  await expect(gear(page, 'server.local')).toBeVisible()
  await expect(gear(page, STABLE_ID)).toHaveCount(0)

  // 2 台目を非準拠サーバで追加してテスト -> やはり失敗扱いで、1 台目に合流しない。
  // server source 数 = Sources 一覧の gear ([data-action="edit-source"]) 数で数える。
  const serverRows = page.locator('[data-action="edit-source"]')
  const rowsBefore = await serverRows.count()
  await page.locator('[data-action="add-source"]').click()
  await urlInput(page).fill('http://other.box:9999')
  await page.locator('[data-action="test"]').click()
  await expect(page.locator('.status-err')).toBeVisible()
  await page.locator('[data-action="home"]').click()
  const rowsAfter = await serverRows.count()
  // 新規 source が独立した行として残る (空 machineId 同士で 1 source に潰れていない)。
  expect(rowsAfter).toBe(rowsBefore + 1)
})

test('remove then re-add the same machine restores the glass layout', async ({ page }) => {
  // host-testbox に安定化し、glass layout を Customize (group=1行で生成) する。
  await gear(page, 'server.local').click()
  await testConnection(page, 'http://localhost:5273')
  await page.locator('[data-action="home"]').click()
  await expect(gear(page, STABLE_ID)).toBeVisible()

  // Glass を Customize -> glassLayout 生成 (CPU/Memory が行に乗る)。Done で編集終了。
  await page.locator('[data-action="layout-customize"]').click()
  await expect(page.locator('.wys-screen')).toBeVisible()
  // CPU の segKey chip が配置されている (host-testbox|cpu|usage)。
  const cpuChip = `.wys-chip[data-segkey^="${STABLE_ID}|cpu|"]`
  await expect(page.locator(cpuChip).first()).toBeVisible()
  await page.locator('[data-action="layout-edit-toggle"]').click() // Done

  // 削除する (tombstone に host-testbox の view が退避される)。
  await gear(page, STABLE_ID).click()
  page.once('dialog', (d) => d.accept())
  await page.locator('[data-action="remove-source"]').click()
  await expect(gear(page, STABLE_ID)).toHaveCount(0)

  // 同一マシンを再追加 -> 同じ host-testbox に収束し glassLayout が復活する。
  await page.locator('[data-action="add-source"]').click()
  await testConnection(page, 'http://localhost:5273')
  await page.locator('[data-action="home"]').click()
  await expect(gear(page, STABLE_ID)).toBeVisible()
  // Customize し直さずとも glassLayout が残っている = tombstone から復元された。
  // Edit layout を開いて CPU chip が再び配置されていることを確認する。
  await page.locator('[data-action="layout-edit-toggle"]').click()
  await expect(page.locator('.wys-screen')).toBeVisible()
  await expect(page.locator(cpuChip).first()).toBeVisible()
})
