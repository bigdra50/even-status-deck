// Vite dev middleware shim。devApiPlugin を vite.config.ts から移植し、Node 上で動かす。
// http-server.ts (standalone サーバー) は import しない。vite dev は middleware 経由でハンドラを使う。
// machineInfo / buildStatusDoc / loadServerConfig は standalone と同一実装を共有する。
import type { ViteDevServer } from 'vite'
import { loadServerConfig } from './config.ts'
import { machineInfo } from './machine.ts'
import { buildStatusDoc } from './status.ts'

export function devApiPlugin() {
  return {
    name: 'toolbar-dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/machine', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        try {
          res.end(JSON.stringify(await machineInfo()))
        } catch (e) {
          // 詳細 (ローカルパス等) は LAN クライアントに返さずサーバーログへ。
          console.error('[api] /api/machine failed:', e)
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })
      server.middlewares.use('/api/status', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        try {
          res.end(JSON.stringify(await buildStatusDoc(await loadServerConfig())))
        } catch (e) {
          console.error('[api] /api/status failed:', e)
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })
    },
  }
}
