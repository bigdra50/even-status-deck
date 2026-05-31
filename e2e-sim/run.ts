// EvenHub simulator automation E2E.
//
// 前提: dev server (アプリ) と simulator (--automation-port) が起動済み。
//   ローカル: `bun run dev` と `bun run sim:auto` を別ターミナルで起動してから `bun run test:sim`。
//   CI:       .github/workflows/sim-e2e.yml が両者を背景起動してから本スクリプトを実行する。
//
// 検証内容 (simulator 上でアプリが健全に動くかの回帰検出):
//   1. /api/ping が pong を返す (simulator 起動)
//   2. console に ready マーク (Bridge initialized) が出る (アプリ起動)
//   3. console に error / uncaught / unhandledrejection / 失敗 fetch が無い
//   4. /api/screenshot/glasses が妥当な PNG を返し、空 (全透過) でない
//   5. /api/input が受理され、送信後も simulator がクラッシュせず描画を返す
//
// 点灯ピクセルの厳密な alpha カウントは将来 pngjs 等で拡張可能。現状は PNG サイズ下限で
// 「空でない描画」を担保する (依存追加を避ける)。input 差分は glass の時計表示で常に変わる
// ため assert しない (操作の受理とクラッシュ無しのみ確認)。

const PORT = Number(process.env.SIM_PORT ?? 9898)
const BASE = `http://127.0.0.1:${PORT}`
const READY_MARK = 'Bridge initialized' // EvenAppBridge 初期化ログ
const SCREENSHOT_MIN_BYTES = 1500 // 空 (全透過) PNG 除外の下限

type ConsoleEntry = { id: number; level: string; message: string; ts: number }
type InputAction = 'up' | 'down' | 'click' | 'double_click'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (m: string): void => console.log(`[sim-e2e] ${m}`)
const fail = (m: string): never => {
  console.error(`[sim-e2e] FAIL: ${m}`)
  process.exit(1)
}

async function ping(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/ping`)
    return r.ok && (await r.text()).includes('pong')
  } catch {
    return false
  }
}

async function getConsole(): Promise<ConsoleEntry[]> {
  const r = await fetch(`${BASE}/api/console`)
  if (!r.ok) throw new Error(`/api/console -> ${r.status}`)
  const j = (await r.json()) as { entries: ConsoleEntry[] }
  return j.entries
}

async function getScreenshot(): Promise<Uint8Array> {
  const r = await fetch(`${BASE}/api/screenshot/glasses`)
  if (!r.ok) throw new Error(`/api/screenshot/glasses -> ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

async function sendInput(action: InputAction): Promise<boolean> {
  const r = await fetch(`${BASE}/api/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!r.ok) return false
  const j = (await r.json()) as { ok?: boolean }
  return j.ok === true
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const
const isPng = (b: Uint8Array): boolean => PNG_MAGIC.every((x, i) => b[i] === x)

// simulator は非 console 由来を prefix する: [uncaught] / [unhandledrejection] / [fetch]。
function findErrors(entries: ConsoleEntry[]): ConsoleEntry[] {
  return entries.filter(
    (e) => e.level === 'error' || /^\[(uncaught|unhandledrejection|fetch)\]/.test(e.message),
  )
}

async function main(): Promise<void> {
  // 1. simulator 起動待ち
  let up = false
  for (let i = 0; i < 90; i++) {
    if (await ping()) {
      up = true
      break
    }
    await sleep(1000)
  }
  if (!up) fail('simulator /api/ping never responded with pong')
  log('ping ok')

  // 2. アプリ ready 待ち
  let ready = false
  for (let i = 0; i < 30; i++) {
    const entries = await getConsole()
    if (entries.some((e) => e.message.includes(READY_MARK))) {
      ready = true
      break
    }
    await sleep(1000)
  }
  if (!ready) fail(`app ready mark "${READY_MARK}" not seen in console`)
  log('app ready')

  // 3. SDK init / 初回 fetch の落ち着き待ち
  await sleep(4000)

  // 4. console error 検証
  const entries = await getConsole()
  const errors = findErrors(entries)
  if (errors.length > 0) {
    fail(
      `console has ${errors.length} error(s):\n${errors
        .map((e) => `  [${e.level}] ${e.message}`)
        .join('\n')}`,
    )
  }
  log(`console clean (${entries.length} entries, 0 errors)`)

  // 5. glasses 描画検証
  const shot = await getScreenshot()
  if (!isPng(shot)) fail('glasses screenshot is not a PNG')
  if (shot.byteLength < SCREENSHOT_MIN_BYTES) {
    fail(
      `glasses screenshot too small (${shot.byteLength}B < ${SCREENSHOT_MIN_BYTES}B) — likely blank`,
    )
  }
  log(`glasses rendered (${shot.byteLength}B PNG)`)

  // 6. input 受理 + クラッシュ無し
  const ok = await sendInput('down')
  if (!ok) fail('/api/input did not return ok:true')
  await sleep(1000)
  const shotAfter = await getScreenshot()
  if (!isPng(shotAfter)) fail('post-input screenshot is not a PNG (simulator may have crashed)')
  log('input(down) accepted, simulator still rendering')

  log('SIMULATOR E2E PASSED')
}

main().catch((e: unknown) => fail(String((e as Error)?.stack ?? e)))
