#!/usr/bin/env bun
import { runAskCli } from './cli/ask.ts'
import { runProviderCli } from './cli/provider.ts'
import { ensureLegacyDirsMigrated, loadServerConfig } from './config.ts'
// standalone エントリ。`status-deck provider <subcmd>` は provider 管理 CLI へ、
// `status-deck watch <name>` は overlay イベント watcher を起動、
// `status-deck ask <message> [...actions]` は dialog を出して選択を待つ、
// それ以外 (引数なし / `server`) は node:http の HTTP サーバーを起動する。
import { startServer } from './http-server.ts'

// dir を作成/読み書きする全サブコマンドの手前で、旧 eveng2-toolbar dir → 新 status-deck dir を
// best-effort 移行する (provider CLI が loadServerConfig を経ず新 dir を作る前に必ず通す)。
ensureLegacyDirsMigrated()

if (process.argv[2] === 'provider') {
  try {
    await runProviderCli(process.argv.slice(3))
  } catch (e) {
    console.error(`provider: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
} else if (process.argv[2] === 'ask') {
  await runAskCli(process.argv.slice(3))
} else if (process.argv[2] === 'watch') {
  // overlay イベント watcher。現状は mac 通知のみ。watcher は Mac 専用なので動的 import する
  // (通常の server 起動パスに載せない)。別 process で起動し、loopback の /api/emit に投げる。
  const which = process.argv[3] ?? 'mac-notifications'
  if (which === 'mac-notifications' || which === 'mac') {
    const { runMacNotificationsWatcher } = await import('./watchers/mac-notifications.ts')
    await runMacNotificationsWatcher()
  } else {
    console.error(`watch: unknown watcher '${which}' (use 'mac-notifications')`)
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
