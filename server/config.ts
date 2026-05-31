import { existsSync, renameSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type {
  Ledger,
  LedgerEntry,
  ProviderOpts,
  ServerConfig,
  SubprocessEntry,
  WatchersConfig,
} from './types.ts'

// $XDG_CONFIG_HOME/status-deck/ (未設定なら ~/.config/status-deck/)。
export const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'status-deck',
)
// JS plugin provider の autoload 先 (status.ts が走査する)。
export const PROVIDER_DIR = join(CONFIG_DIR, 'providers')

// $XDG_STATE_HOME/status-deck/ (未設定なら ~/.local/state/status-deck/)。
// ledger は「ツールが管理する状態の記録」なので config ではなく STATE に置く。
export const STATE_DIR = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'status-deck',
)
export const LEDGER_PATH = join(STATE_DIR, 'provider-ledger.json')

// 旧 eveng2-toolbar dir からの best-effort 移行。
// リブランド前の config/state を新 dir 名へ引き継ぐ。新 dir が既に存在する場合や
// 旧 dir が無い場合は何もしない。失敗 (権限・競合等) は握り潰し、起動を妨げない。
const OLD_CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'eveng2-toolbar',
)
const OLD_STATE_DIR = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'eveng2-toolbar',
)
let legacyMigrated = false
// 旧 dir → 新 dir 移行を1度だけ実行する。dir を作成/読み書きする全 runtime 入口
// (index.ts の CLI 各サブコマンド + loadServerConfig) の手前で呼ぶこと。provider CLI 等が
// loadServerConfig を経ずに新 dir を作ると以後の移行条件が崩れるため (codex 指摘)。
export function ensureLegacyDirsMigrated(): void {
  if (legacyMigrated) return
  legacyMigrated = true
  try {
    if (!existsSync(CONFIG_DIR) && existsSync(OLD_CONFIG_DIR))
      renameSync(OLD_CONFIG_DIR, CONFIG_DIR)
  } catch {}
  try {
    if (!existsSync(STATE_DIR) && existsSync(OLD_STATE_DIR)) renameSync(OLD_STATE_DIR, STATE_DIR)
  } catch {}
}

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

// 文字列配列のみ採用する。非配列・null は undefined、要素は string のみ残す。
function parseStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter((x): x is string => typeof x === 'string')
}

// [watchers.mac-notifications] の allow/deny を読む。未設定・不正な型は undefined を返し、
// 既存 parse に影響させない (watchers セクション自体が無ければ ServerConfig.watchers は付かない)。
function parseWatchers(v: unknown): WatchersConfig | undefined {
  if (!v || typeof v !== 'object') return undefined
  const raw = (v as Record<string, unknown>)['mac-notifications']
  if (!raw || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  const allow = parseStringArray(entry.allow)
  const deny = parseStringArray(entry.deny)
  if (!allow && !deny) return undefined
  const mac: WatchersConfig['mac-notifications'] = {}
  if (allow) mac.allow = allow
  if (deny) mac.deny = deny
  return { 'mac-notifications': mac }
}

// ledger エントリの最小 shape 検証。破損・改竄された provider-ledger.json で
// 不正な provider を注入させないため、無効なエントリは破棄する (起動は妨げない)。
function isLedgerEntry(e: unknown): e is LedgerEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as Record<string, unknown>
  if (typeof x.id !== 'string' || x.id === '') return false
  if (typeof x.enabled !== 'boolean') return false
  if (x.kind === 'js') return true
  if (x.kind === 'subprocess') return typeof x.command === 'string' && Array.isArray(x.args)
  return false
}

// provider 管理 ledger を読む。欠落・破損・null・不正エントリは安全側に倒す (空 or 該当エントリ破棄)。
// 書き込み (saveLedger + O_EXCL ロック) は最初の writer = `provider enable/disable` 等の CLI で追加する。
export async function loadLedger(): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(LEDGER_PATH, 'utf8')) as unknown
    const raw = (parsed as { providers?: unknown } | null)?.providers
    if (raw && typeof raw === 'object') {
      const providers: Record<string, LedgerEntry> = {}
      for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
        // id とエントリの id が一致し shape が妥当なものだけ採用する。
        if (isLedgerEntry(entry) && entry.id === id) providers[id] = entry
        else console.warn(`[ledger] 不正な provider エントリを無視: ${id}`)
      }
      return { version: 1, providers }
    }
  } catch {
    // missing / corrupt JSON → 空
  }
  return { version: 1, providers: {} }
}

// config.toml の providers と ledger を統合する。
// - ledger の managed エントリ (config に無いもの) を cfg.providers に注入する
//   (subprocess は command/args/ttl/timeout、JS は空 opts。これで gate を通せる)。
// - enabled は 3 段優先: ① config に enabled 明示 → それ ② config セクションあり enabled 無し → ledger.enabled
//   ③ config セクション無し (ledger のみ) → ledger.enabled。いずれも無ければ true。
export function mergeProviders(
  configProviders: ServerConfig['providers'],
  ledger: Ledger,
): ServerConfig['providers'] {
  const out: ServerConfig['providers'] = {}
  const ids = new Set([...Object.keys(configProviders), ...Object.keys(ledger.providers)])
  for (const id of ids) {
    const cfg = configProviders[id]
    const led = ledger.providers[id]
    let entry: ProviderOpts | SubprocessEntry
    if (cfg) {
      entry = { ...cfg }
    } else if (led?.kind === 'subprocess') {
      entry = {
        command: led.command,
        args: led.args,
        timeoutMs: led.timeoutMs,
        ttlMs: led.ttlMs,
      } satisfies SubprocessEntry
    } else {
      entry = {} // JS の ledger エントリ → 空 opts (gate 通過用)
    }
    if (cfg && 'enabled' in cfg) entry.enabled = cfg.enabled !== false
    else if (led) entry.enabled = led.enabled
    else entry.enabled = true
    out[id] = entry
  }
  return out
}

export async function loadServerConfig(): Promise<ServerConfig> {
  ensureLegacyDirsMigrated()
  if (cache && Date.now() - cache.at < CONFIG_TTL_MS) return cache.data
  const parsed = ((await readConfigFile('config.toml')) ??
    (await readConfigFile('config.json'))) as {
    providers?: unknown
    port?: unknown
    watchers?: unknown
  } | null
  const rawProviders = parsed?.providers
  const configProviders =
    rawProviders && typeof rawProviders === 'object'
      ? (rawProviders as ServerConfig['providers'])
      : {}
  const providers = mergeProviders(configProviders, await loadLedger())
  const data: ServerConfig = { providers }
  const port = parsePort(parsed?.port)
  if (port !== undefined) data.port = port
  const watchers = parseWatchers(parsed?.watchers)
  if (watchers !== undefined) data.watchers = watchers
  cache = { data, at: Date.now() }
  return data
}
