// standalone HTTP サーバー (node:http)。bun / node どちらのランタイムでも動く。
// /api/machine → machineInfo、/api/status → buildStatusDoc。
// /api/events → transient overlay イベントの long-poll (LAN 公開)。
// /api/emit  → イベント投入 (POST, loopback 127.0.0.1 限定 = 同一 Mac の watcher のみ)。
// 詳細なエラー (ローカルパス等) は LAN クライアントに返さず console.error にのみ出す。
// CORS は loopback/LAN では不要 (PROTOCOL §7)。'*' を付けておけば別ポート dev でも困らない。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { parseEmitInput } from '../src/event-types.ts'
import { loadServerConfig } from './config.ts'
import { emitEvent, pollEvents } from './events.ts'
import { machineInfo } from './machine.ts'
import { buildStatusDoc } from './status.ts'
import type { ServerConfig } from './types.ts'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
} as const

const EVENTS_WAIT_MAX_MS = 30_000
const EVENTS_WAIT_DEFAULT_MS = 25_000
const EMIT_BODY_MAX_BYTES = 8 * 1024 // emit body の上限 (巨大 POST を弾く)

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

// remoteAddress が loopback か。emit を同一ホスト (watcher) に限定して通知偽装を防ぐ。
function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

// POST body を上限付きで読む。超過したら null (呼び出し側が 413)。
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function parseIntParam(v: string | null, fallback: number): number {
  const n = v == null ? Number.NaN : Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

// GET /api/events?since=<seq>&waitMs=<ms> : long-poll。pending か reset で即返す。
async function handleEvents(res: ServerResponse, url: URL): Promise<void> {
  const since = Math.max(0, parseIntParam(url.searchParams.get('since'), 0))
  const waitMs = Math.max(
    0,
    Math.min(parseIntParam(url.searchParams.get('waitMs'), EVENTS_WAIT_DEFAULT_MS), EVENTS_WAIT_MAX_MS),
  )
  const result = await pollEvents(since, waitMs, (cb) => {
    res.on('close', cb) // client 切断時に待機を解除 (リーク防止)
  })
  const { machineId } = await machineInfo()
  sendJson(res, 200, { version: 1, sourceId: machineId, ...result })
}

// POST /api/emit : イベント投入 (loopback 限定)。重複/rate/不正は静かに拒否する。
async function handleEmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback only' })
    return
  }
  const raw = await readBody(req, EMIT_BODY_MAX_BYTES)
  if (raw == null) {
    sendJson(res, 413, { ok: false, error: 'body too large' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid json' })
    return
  }
  const input = parseEmitInput(parsed)
  if (!input) {
    sendJson(res, 400, { ok: false, error: 'invalid event' })
    return
  }
  const r = emitEvent(input)
  if (!r.ok) {
    // duplicate / rate は 200 (ok:false) で返す。watcher 側は再送しなくてよい。
    sendJson(res, 200, { ok: false, reason: r.reason })
    return
  }
  sendJson(res, 200, { ok: true, seq: r.seq })
}

// OD-3: 起動時に LAN IP を console.log するだけ (QR / qrcode-terminal は入れない)。
function printAddresses(port: number): void {
  const nets = networkInterfaces()
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`  LAN: http://${addr.address}:${port}`)
      }
    }
  }
}

// cfg は将来 serve オプションを config 駆動にする余地のため受けるが、現状は未使用
// (ハンドラが毎リクエスト loadServerConfig() で最新を読むため)。port のみ使う。
export function startServer(_cfg: ServerConfig, port: number): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    try {
      if (pathname === '/api/machine') {
        sendJson(res, 200, await machineInfo())
        return
      }
      if (pathname === '/api/status') {
        sendJson(res, 200, await buildStatusDoc(await loadServerConfig()))
        return
      }
      if (pathname === '/api/events') {
        await handleEvents(res, url)
        return
      }
      if (pathname === '/api/emit' && req.method === 'POST') {
        await handleEmit(req, res)
        return
      }
    } catch (e) {
      // 詳細 (ローカルパス等) は LAN クライアントに返さずサーバーログへ。
      console.error(`[api] ${pathname} failed:`, e)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })
  server.listen(port, '0.0.0.0', () => {
    console.log(`eveng2-toolbar-server listening on http://0.0.0.0:${port}`)
    printAddresses(port)
  })
}
