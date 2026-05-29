#!/usr/bin/env bun
import { startServer } from './bun-server.ts'
// standalone エントリ。config を読み、port を解決して Bun.serve を起動する。
// port 優先順位: config の port → EVENG2_PORT (正の整数のみ) → 既定 8723。
// C-2 解決: Number(undefined) は NaN なので Number.isInteger + > 0 でガードし NaN を 8723 に落とす。
import { loadServerConfig } from './config.ts'

const cfg = await loadServerConfig()
const envPort = Number(process.env.EVENG2_PORT)
const port = cfg.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 8723)
startServer(cfg, port)
