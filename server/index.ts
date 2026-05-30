#!/usr/bin/env bun
import { runProviderCli } from './cli/provider.ts'
import { loadServerConfig } from './config.ts'
// standalone エントリ。`eveng2-toolbar provider <subcmd>` は provider 管理 CLI へ、
// それ以外 (引数なし / `server`) は node:http の HTTP サーバーを起動する。
import { startServer } from './http-server.ts'

if (process.argv[2] === 'provider') {
  try {
    await runProviderCli(process.argv.slice(3))
  } catch (e) {
    console.error(`provider: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
} else {
  // port 優先順位: config の port → EVENG2_PORT (正の整数のみ) → 既定 8723。
  // C-2 解決: Number(undefined) は NaN なので Number.isInteger + > 0 でガードし NaN を 8723 に落とす。
  const cfg = await loadServerConfig()
  const envPort = Number(process.env.EVENG2_PORT)
  const port = cfg.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 8723)
  startServer(cfg, port)
}
