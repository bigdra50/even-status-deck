// standalone HTTP サーバー (Bun.serve)。ファイル名で Bun 専用を明示し (I-4)、
// Bun ランタイム以外から import されたら即座にエラーにする。
// /api/machine → machineInfo、/api/status → buildStatusDoc(await loadServerConfig())。
// 詳細なエラー (ローカルパス等) は LAN クライアントに返さず console.error にのみ出す。
// CORS は loopback/LAN では不要 (PROTOCOL §7)。'*' を付けておけば別ポート dev でも困らない。

// I-4 解決: 万一 Node 経路から import されても即座に明確なエラーを出す。
if (typeof Bun === 'undefined') throw new Error('bun-server.ts requires the Bun runtime')

import { networkInterfaces } from 'node:os'
import { loadServerConfig } from './config.ts'
import { machineInfo } from './machine.ts'
import { buildStatusDoc } from './status.ts'
import type { ServerConfig } from './types.ts'

function respondJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

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
// (fetch ハンドラが毎リクエスト loadServerConfig() で最新を読むため)。port のみ使う。
export function startServer(_cfg: ServerConfig, port: number): void {
  Bun.serve({
    port,
    hostname: '0.0.0.0',
    async fetch(req) {
      const { pathname } = new URL(req.url)
      try {
        if (pathname === '/api/machine') return respondJson(await machineInfo())
        if (pathname === '/api/status')
          return respondJson(await buildStatusDoc(await loadServerConfig()))
      } catch (e) {
        // 詳細 (ローカルパス等) は LAN クライアントに返さずサーバーログへ。
        console.error(`[api] ${pathname} failed:`, e)
        return new Response(JSON.stringify({ error: 'internal error' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
      return new Response('Not Found', { status: 404 })
    },
  })
  console.log(`eveng2-toolbar-server listening on http://0.0.0.0:${port}`)
  printAddresses(port)
}
