import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ServerConfig } from './types.ts'

// $XDG_CONFIG_HOME/eveng2-toolbar/ (未設定なら ~/.config/eveng2-toolbar/)。
export const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'eveng2-toolbar',
)
// JS plugin provider の autoload 先 (status.ts が走査する)。
export const PROVIDER_DIR = join(CONFIG_DIR, 'providers')

// config.toml (smol-toml) か config.json で provider の有効/無効・オプション・port を指定。
// standalone は高頻度に /api/status を poll するため、毎リクエストの I/O を避けて 3s TTL で
// キャッシュする (Issue3)。トグルは最大 3s 遅延で反映される (許容)。
const CONFIG_TTL_MS = 3_000
let cache: { data: ServerConfig; at: number } | null = null

async function readConfigFile(file: string): Promise<unknown> {
  try {
    const text = await readFile(join(CONFIG_DIR, file), 'utf8')
    return file.endsWith('.toml') ? parseToml(text) : JSON.parse(text)
  } catch {
    return null
  }
}

// 正の整数のみ port として採用する。0 / 負数 / 小数 / 非数値は undefined (index.ts が解決)。
function parsePort(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
}

export async function loadServerConfig(): Promise<ServerConfig> {
  if (cache && Date.now() - cache.at < CONFIG_TTL_MS) return cache.data
  const parsed = ((await readConfigFile('config.toml')) ??
    (await readConfigFile('config.json'))) as { providers?: unknown; port?: unknown } | null
  const rawProviders = parsed?.providers
  const providers =
    rawProviders && typeof rawProviders === 'object'
      ? (rawProviders as ServerConfig['providers'])
      : {}
  const data: ServerConfig = { providers }
  const port = parsePort(parsed?.port)
  if (port !== undefined) data.port = port
  cache = { data, at: Date.now() }
  return data
}
