// dialog 往復の確認/利用 CLI。loopback から dialog を emit し、グラスでの選択結果を待つ。
//   bun run server ask "本番にデプロイ?" はい いいえ
//   bun run server ask --title 確認 --timeout 30000 "削除しますか?" キャンセル 削除
// stdout に選択ラベルを 1 行出す (スクリプトから `$(...)` で受けられる)。stderr は人間向けログ。
// 終了コード: 0=回答あり / 1=expired/dismissed/timeout / 2=使い方・接続エラー。
import { randomBytes } from 'node:crypto'
import { loadServerConfig } from '../config.ts'

type Parsed = { title?: string; message: string; actions: string[]; ttlMs: number }

function parseArgs(argv: string[]): Parsed | null {
  let title: string | undefined
  let ttlMs = 60_000
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--title') {
      title = argv[++i]
      continue
    }
    if (a === '--timeout') {
      const n = Number(argv[++i])
      if (Number.isFinite(n) && n > 0) ttlMs = n
      continue
    }
    if (a !== undefined) rest.push(a)
  }
  const [message, ...actions] = rest
  if (!message) return null
  return { title, message, actions: actions.length ? actions : ['はい', 'いいえ'], ttlMs }
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url)
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

// ベース URL を決める (cfg.port > $EVENG2_PORT > 既定 8723)。
function resolveBaseUrl(cfg: { port?: number }): string {
  const envPort = Number(process.env.EVENG2_PORT)
  const port = cfg.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 8723)
  return `http://127.0.0.1:${port}`
}

// dialog を emit し、requestId を払い出す。失敗時は process.exit(2) (戻らない)。
async function emitDialog(base: string, id: string, p: Parsed): Promise<string> {
  const emit = await postJson(`${base}/api/emit`, {
    providerId: 'ask-cli',
    id,
    kind: 'dialog',
    title: p.title,
    message: p.message,
    actions: p.actions,
    ttlMs: p.ttlMs,
  })
  if (!emit?.ok || typeof emit.requestId !== 'string') {
    console.error(`ask: emit に失敗 (${emit?.reason ?? emit?.error ?? 'サーバーに繋がりません'})`)
    process.exit(2)
  }
  return emit.requestId
}

// 1 回分の long-poll 結果を処理する。pending なら null を返して呼び出し側が再ポーリングする。
// completed/dismissed/expired は process.exit で戻らない。
async function handlePollResult(base: string, requestId: string): Promise<'pending' | never> {
  const r = await getJson(`${base}/api/action-result?requestId=${requestId}&waitMs=30000`)
  if (!r?.ok) {
    console.error(`ask: 結果取得に失敗 (${r?.error ?? '接続エラー'})`)
    process.exit(2)
  }
  if (r.status === 'pending') return 'pending' // long-poll タイムアウト → 再ポーリング
  if (r.status === 'completed') {
    const result = r.result as { index: number; action: string } | undefined
    if (result) {
      process.stdout.write(`${result.action}\n`) // stdout = 選択ラベル
      console.error(`ask: 選択 = ${result.action} (index ${result.index})`)
      process.exit(0)
    }
  }
  console.error(`ask: ${r.status}`) // dismissed / expired
  process.exit(1)
}

export async function runAskCli(argv: string[]): Promise<void> {
  const p = parseArgs(argv)
  if (!p) {
    console.error('usage: ask [--title T] [--timeout ms] <message> [action1 action2 ...]')
    process.exit(2)
  }
  const cfg = await loadServerConfig()
  const base = resolveBaseUrl(cfg)
  const id = `ask-${randomBytes(6).toString('hex')}`

  const requestId = await emitDialog(base, id, p)
  console.error(`ask: 質問を送信しました。グラスで選択を待っています... (requestId=${requestId})`)

  const deadline = Date.now() + p.ttlMs + 5_000
  while (Date.now() < deadline) {
    await handlePollResult(base, requestId)
  }
  console.error('ask: タイムアウト')
  process.exit(1)
}
