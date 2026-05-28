// [DIAG] 一時診断: dev server 停止 / WebView 白画面の原因を特定する計測。
// 原因特定後に削除する。vite.config.ts の `import { devDiagPlugin }` と plugins 登録も外すこと。
//
// 出力:
//   /tmp/eveng2-dev-diag.log     … サーバ(node/bun)プロセスの mem 推移 / 例外 / 終了種別
//   /tmp/eveng2-client-diag.log  … スマホ WebView からの heartbeat / error / pagehide 等
//
// 判別の指針 (server):
//   - heapUsed が heapLimit 付近まで上昇し EXIT 行が無い → V8 ヒープ枯渇 (OOM abort)。
//   - UNCAUGHT / UNHANDLED_REJECTION 行あり → そのスタックが原因。
// 判別の指針 (client = 白画面):
//   - beat が突然途絶え、直前に error/pagehide が無い → WebView レンダラ kill 濃厚。
//   - usedMB が limitMB 付近まで上昇していれば JS ヒープ起因のレンダラ OOM。
//   - pagehide/freeze の直後に途絶え → ライフサイクルによる suspend/破棄。
import { appendFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as v8 from 'node:v8'
import type { ViteDevServer } from 'vite'

const SERVER_LOG = '/tmp/eveng2-dev-diag.log'
const CLIENT_LOG = '/tmp/eveng2-client-diag.log'

function memLine(): string {
  const m = process.memoryUsage()
  const mb = (n: number) => Math.round(n / 1048576)
  return `rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} heapTotal=${mb(m.heapTotal)} ext=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)} (MB)`
}

function append(file: string, line: string): void {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 診断ログ書込み失敗は無視 */
  }
}

const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`
let heapLimitMb = 0
try {
  heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576)
} catch {
  /* bun 等で未実装なら 0 のまま */
}
append(SERVER_LOG, `=== START pid=${process.pid} runtime=${runtime} heapLimit=${heapLimitMb}MB ===`)

// 10s ごとにサーバプロセスのメモリ推移を記録。unref で本タイマー自体は寿命を延ばさない。
const timer = setInterval(() => append(SERVER_LOG, `mem ${memLine()}`), 10_000)
;(timer as { unref?: () => void }).unref?.()

// 既定の異常終了 (print + exit) を踏襲しつつ、原因とメモリ状態を残す。
process.on('uncaughtException', (e) => {
  const msg = `UNCAUGHT ${memLine()} :: ${e?.stack ?? String(e)}`
  append(SERVER_LOG, msg)
  console.error(`[dev-diag] ${msg}`)
  process.exit(1)
})
process.on('unhandledRejection', (r) => {
  const msg = `UNHANDLED_REJECTION ${memLine()} :: ${r instanceof Error ? r.stack : String(r)}`
  append(SERVER_LOG, msg)
  console.error(`[dev-diag] ${msg}`)
  process.exit(1)
})
process.on('exit', (code) => append(SERVER_LOG, `EXIT code=${code} ${memLine()}`))

// スマホ WebView からの heartbeat を受ける。client-diag.ts が POST /__diag で送る。
export function devDiagPlugin() {
  return {
    name: 'eveng2-dev-diag',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__diag', (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'content-type')
          res.statusCode = 204
          res.end()
          return
        }
        let body = ''
        req.on('data', (c) => {
          body += c
        })
        req.on('error', () => {
          res.statusCode = 400
          res.end()
        })
        req.on('end', () => {
          append(CLIENT_LOG, `CLIENT ${body.trim()}`)
          res.statusCode = 204
          res.end()
        })
      })
    },
  }
}
