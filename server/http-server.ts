// standalone HTTP サーバー (node:http)。bun / node どちらのランタイムでも動く。
// /api/machine → machineInfo、/api/status → buildStatusDoc(await loadServerConfig())。
// 詳細なエラー (ローカルパス等) は LAN クライアントに返さず console.error にのみ出す。
// CORS は loopback/LAN では不要 (PROTOCOL §7)。'*' を付けておけば別ポート dev でも困らない。

import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { loadServerConfig } from './config.ts'
import { machineInfo } from './machine.ts'
import { buildStatusDoc } from './status.ts'
import type { ServerConfig } from './types.ts'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
} as const

// OD-3: 起動時に LAN IP を console.log するだけ (QR / qrcode-terminal は入れない)。
// node:os の networkInterfaces から非内部 (internal=false) の IPv4 を列挙する。
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
    // node:http の req.url はパス+クエリのみ。ダミーホストで補ってパス名だけ取り出す。
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    try {
      if (pathname === '/api/machine') {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(await machineInfo()))
        return
      }
      if (pathname === '/api/status') {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(await buildStatusDoc(await loadServerConfig())))
        return
      }
    } catch (e) {
      // 詳細 (ローカルパス等) は LAN クライアントに返さずサーバーログへ。
      console.error(`[api] ${pathname} failed:`, e)
      res.writeHead(500, JSON_HEADERS)
      res.end(JSON.stringify({ error: 'internal error' }))
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
