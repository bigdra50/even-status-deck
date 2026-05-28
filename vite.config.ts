import { devDiagPlugin } from './dev-diag' // [DIAG] 一時: 停止/白画面の計測。特定後に dev-diag.ts ごと削除。
import { execFile, spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { cpus, hostname, homedir, loadavg, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parse as parseToml } from 'smol-toml'
import { defineConfig, type ViteDevServer } from 'vite'
import type { Group, Segment, StatusDoc } from './src/status-types'

const pexec = promisify(execFile)

// =============================================================================
// dev server 専用データソース (sideload)。トークン/認証はサーバー内に留め、
// フロントには集計済み値だけ返す。store 配布(.ehpk)時は固定クラウドに差し替える。
// =============================================================================

// --- (0) machine: hostname + ツール自動検出 -----------------------------------
let machineCache: { data: unknown; at: number } | null = null
const MACHINE_TTL_MS = 60_000

async function hasCli(cmd: string): Promise<boolean> {
  try {
    await pexec(cmd, ['--version'])
    return true
  } catch {
    return false
  }
}

async function machineInfo(): Promise<unknown> {
  if (machineCache && Date.now() - machineCache.at < MACHINE_TTL_MS) return machineCache.data
  const host = hostname()
  const machineId = host.toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9]+/g, '-')
  const available: string[] = []
  if (await hasCli('claude')) available.push('claude-code')
  if (await hasCli('codex')) available.push('codex')
  const data = { machineId, label: host, availableSources: available }
  machineCache = { data, at: Date.now() }
  return data
}

// --- (1) Claude Code rate limit: /api/oauth/usage (非公式, keychain OAuth) -----
let claudeCache: { data: unknown; at: number } | null = null
const CLAUDE_TTL_MS = 120_000

async function oauthToken(): Promise<string | null> {
  try {
    const { stdout } = await pexec('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ])
    return JSON.parse(stdout)?.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

async function claudeVersion(): Promise<string> {
  try {
    const { stdout } = await pexec('claude', ['--version'])
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? '2.0.0'
  } catch {
    return '2.0.0'
  }
}

async function fetchClaudeLimits(): Promise<unknown> {
  if (claudeCache && Date.now() - claudeCache.at < CLAUDE_TTL_MS) return claudeCache.data
  const token = await oauthToken()
  if (!token) return { error: 'no oauth token (keychain)' }
  const ver = await claudeVersion()
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': `claude-code/${ver}`,
      },
    })
    if (!res.ok) return { error: `usage http ${res.status}` }
    const data = await res.json()
    claudeCache = { data, at: Date.now() }
    return data
  } catch (e) {
    return { error: String(e) }
  }
}

// --- (2) Codex CLI rate limit: codex app-server JSON-RPC (experimental) --------
let codexCache: { data: unknown; at: number } | null = null
const CODEX_TTL_MS = 60_000

function fetchCodexLimits(): Promise<unknown> {
  if (codexCache && Date.now() - codexCache.at < CODEX_TTL_MS) return Promise.resolve(codexCache.data)
  return new Promise((resolve) => {
    const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const rl = createInterface({ input: proc.stdout })
    let done = false
    const send = (m: unknown) => proc.stdin.write(`${JSON.stringify(m)}\n`)
    const finish = (data: unknown, ok: boolean) => {
      if (done) return
      done = true
      try {
        proc.kill()
      } catch {
        /* noop */
      }
      if (ok) codexCache = { data, at: Date.now() }
      resolve(data)
    }
    rl.on('line', (line) => {
      let msg: { id?: number; error?: unknown; result?: { rateLimits?: { primary?: unknown } } }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id === 0) {
        send({ method: 'initialized' })
        // 認証完了を待つ (500ms だと primary が null になることがある)
        setTimeout(() => send({ id: 1, method: 'account/rateLimits/read', params: {} }), 1500)
      } else if (msg.id === 1) {
        if (msg.error) finish({ error: 'codex rpc error' }, false)
        else {
          const rl2 = msg.result?.rateLimits
          finish(rl2 ?? { error: 'no rateLimits' }, Boolean(rl2?.primary))
        }
      }
    })
    proc.on('error', () => finish({ error: 'codex spawn failed' }, false))
    setTimeout(() => finish({ error: 'codex timeout' }, false), 9000)
    send({
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'eveng2-toolbar', title: 'Statusline', version: '0.1.0' } },
    })
  })
}

// --- (3) Claude Code 累積トークン (今日分): cost / msgs 用 ----------------------
type Pricing = { input: number; output: number; cacheWrite: number; cacheRead: number }
const PRICING: Record<string, Pricing> = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
}
function pricingFor(model: string): Pricing {
  if (model.includes('opus')) return PRICING.opus
  if (model.includes('haiku')) return PRICING.haiku
  return PRICING.sonnet
}
function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
type UsageLine = {
  type?: string
  timestamp?: string
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}
async function collectUsage(): Promise<unknown> {
  const root = join(homedir(), '.claude', 'projects')
  const todayKey = localDateKey(new Date())
  const sinceMs = Date.now() - 36 * 3600 * 1000
  let rel: string[]
  try {
    rel = (await readdir(root, { recursive: true })).filter((p) => p.endsWith('.jsonl'))
  } catch {
    return { date: todayKey, error: 'no ~/.claude/projects' }
  }
  let input = 0
  let output = 0
  let cacheWrite = 0
  let cacheRead = 0
  let messages = 0
  let cost = 0
  for (const r of rel) {
    const file = join(root, r)
    try {
      const st = await stat(file)
      if (st.mtimeMs < sinceMs) continue
      const text = await readFile(file, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue
        let obj: UsageLine
        try {
          obj = JSON.parse(line) as UsageLine
        } catch {
          continue
        }
        const u = obj.message?.usage
        if (obj.type !== 'assistant' || !u || !obj.timestamp) continue
        if (localDateKey(new Date(obj.timestamp)) !== todayKey) continue
        const model = obj.message?.model ?? 'sonnet'
        const inT = u.input_tokens ?? 0
        const outT = u.output_tokens ?? 0
        const cwT = u.cache_creation_input_tokens ?? 0
        const crT = u.cache_read_input_tokens ?? 0
        input += inT
        output += outT
        cacheWrite += cwT
        cacheRead += crT
        messages += 1
        const p = pricingFor(model)
        cost += (inT * p.input + outT * p.output + cwT * p.cacheWrite + crT * p.cacheRead) / 1e6
      }
    } catch {
      /* skip unreadable */
    }
  }
  return {
    date: todayKey,
    messages,
    input,
    output,
    cacheWrite,
    cacheRead,
    estCostUsd: Math.round(cost * 100) / 100,
  }
}

// --- (4) status: provider 群を集約し segment を返す (モジュラーコア) -------------
// provider を足すだけで表示要素が増える。value はサーバーで整形済み、percent は bar 用。
function fmtReset(v: string | number | null | undefined): string {
  if (v == null) return ''
  const t = typeof v === 'number' ? v * 1000 : new Date(v).getTime()
  const ms = t - Date.now()
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d${h % 24}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

type PctWin = { utilization?: number; resets_at?: string | null }
function pctSegment(
  id: string,
  label: string,
  pct: number | undefined,
  reset: string | number | null | undefined,
  defaultEnabled: boolean,
): Segment {
  if (typeof pct === 'number') {
    return { id, label, value: `${pct}%`, percent: pct, reset: fmtReset(reset), defaultEnabled }
  }
  return { id, label, value: 'n/a', defaultEnabled }
}

async function claudeProvider(): Promise<Group | null> {
  if (!(await hasCli('claude'))) return null
  const [limits, usage] = await Promise.all([fetchClaudeLimits(), collectUsage()])
  const L = limits as {
    five_hour?: PctWin
    seven_day?: PctWin
    seven_day_sonnet?: PctWin
    seven_day_opus?: PctWin
  }
  const U = usage as { estCostUsd?: number; messages?: number }
  const segments: Segment[] = [
    pctSegment('session', '5h', L.five_hour?.utilization, L.five_hour?.resets_at, true),
    pctSegment('weekly', 'Weekly', L.seven_day?.utilization, L.seven_day?.resets_at, true),
    pctSegment('sonnet', 'Sonnet', L.seven_day_sonnet?.utilization, L.seven_day_sonnet?.resets_at, false),
    pctSegment('opus', 'Opus', L.seven_day_opus?.utilization, L.seven_day_opus?.resets_at, false),
    {
      id: 'cost',
      label: 'Cost',
      value: U.estCostUsd != null ? `$${Math.round(U.estCostUsd)}` : 'n/a',
      defaultEnabled: true,
    },
    {
      id: 'msgs',
      label: 'Msgs',
      value: U.messages != null ? String(U.messages) : 'n/a',
      defaultEnabled: false,
    },
  ]
  return { id: 'claude-code', label: 'Claude Code', segments }
}

async function codexProvider(): Promise<Group | null> {
  if (!(await hasCli('codex'))) return null
  const x = (await fetchCodexLimits()) as {
    primary?: { usedPercent?: number; resetsAt?: number }
    secondary?: { usedPercent?: number; resetsAt?: number }
  }
  return {
    id: 'codex',
    label: 'Codex',
    segments: [
      pctSegment('5h', '5h', x.primary?.usedPercent, x.primary?.resetsAt, true),
      pctSegment('weekly', 'Weekly', x.secondary?.usedPercent, x.secondary?.resetsAt, true),
    ],
  }
}

// --- (5) Mac システム状態 provider (CPU / メモリ / バッテリー / ディスク) ----------
async function shell(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await pexec(cmd, args)).stdout
  } catch {
    return null
  }
}

// CPU: 1 分 load average をコア数で割った概算使用率 (0-100)。
function cpuLoadPct(): number {
  const cores = cpus().length || 1
  return Math.min(100, Math.round((loadavg()[0] / cores) * 100))
}

// メモリ: vm_stat の active+wired+compressed を使用量とする (macOS のキャッシュを除いた実使用)。
async function macMemUsedPct(): Promise<number | null> {
  const out = await shell('vm_stat', [])
  if (!out) return null
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096)
  const pages = (re: RegExp) => Number(out.match(re)?.[1] ?? 0)
  const used =
    (pages(/Pages active:\s+(\d+)/) +
      pages(/Pages wired down:\s+(\d+)/) +
      pages(/Pages occupied by compressor:\s+(\d+)/)) *
    pageSize
  const total = totalmem()
  return total > 0 ? Math.round((used / total) * 100) : null
}

// バッテリー: pmset。バッテリー非搭載 (デスクトップ Mac) なら null。
async function macBattery(): Promise<{ pct: number; charging: boolean } | null> {
  const out = await shell('pmset', ['-g', 'batt'])
  const m = out?.match(/(\d+)%/)
  if (!m) return null
  const charging = /AC Power/.test(out ?? '') && !/discharging/i.test(out ?? '')
  return { pct: Number(m[1]), charging }
}

// ディスク: ルートの空き容量 (GB) と使用率 (%)。df -k の 4 列目 (Available KB) / 5 列目 (Capacity)。
async function diskInfo(): Promise<{ freeGb: number; usedPct: number | null } | null> {
  const out = await shell('df', ['-k', '/'])
  const cols = out?.trim().split('\n')[1]?.split(/\s+/)
  const avail = Number(cols?.[3])
  if (!Number.isFinite(avail)) return null
  const freeGb = Math.round((avail / 1024 / 1024) * 10) / 10
  const cap = Number(cols?.[4]?.replace('%', ''))
  return { freeGb, usedPct: Number.isFinite(cap) ? cap : null }
}

async function macSystemProvider(): Promise<Group | null> {
  const [mem, bat, disk] = await Promise.all([macMemUsedPct(), macBattery(), diskInfo()])
  const cpu = cpuLoadPct()
  const segments: Segment[] = [
    { id: 'cpu', label: 'CPU', value: `${cpu}%`, percent: cpu, defaultEnabled: true },
  ]
  if (mem != null) {
    segments.push({ id: 'mem', label: 'Mem', value: `${mem}%`, percent: mem, defaultEnabled: true })
  }
  if (bat) {
    segments.push({
      id: 'battery',
      label: 'Bat',
      value: `${bat.pct}%${bat.charging ? '+' : ''}`,
      percent: bat.pct,
      defaultEnabled: false,
    })
  }
  if (disk != null) {
    const seg: Segment = { id: 'disk', label: 'Disk', value: `${disk.freeGb}G`, defaultEnabled: false }
    if (disk.usedPct != null) seg.percent = disk.usedPct // 使用率% (表示タイミング条件の metric 用)
    segments.push(seg)
  }
  return { id: 'mac', label: 'Mac', segments }
}

// 新規 provider はここに足すだけ (segment 形で返せば companion が自動検出する)。
// provider は manifest ({ id, group })。id を a-priori に持つことで config の enabled を
// 実行前に適用でき、無効 provider は計算も送信もしない。built-in / plugin 共通。
type ProviderCtx = { options: Record<string, unknown> }
type ProviderDef = {
  id: string
  group: (ctx: ProviderCtx) => Promise<Group | null> | Group | null
}

const BUILTINS: ProviderDef[] = [
  { id: 'claude-code', group: claudeProvider },
  { id: 'codex', group: codexProvider },
  { id: 'mac', group: macSystemProvider },
]

// --- (6) 設定ファイル + プラグイン autoload ($XDG_CONFIG_HOME/eveng2-toolbar/) ----------
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'eveng2-toolbar')
const PROVIDER_DIR = join(CONFIG_DIR, 'providers')

// config.toml (bun の TOML parse) か config.json で provider の有効/無効・オプションを指定。
// 毎 poll 再読込するのでトグルは再起動なしで反映される。
type ProviderOpts = { enabled?: boolean } & Record<string, unknown>
type ServerConfig = { providers: Record<string, ProviderOpts> }

async function readConfigFile(file: string): Promise<unknown> {
  try {
    const text = await readFile(join(CONFIG_DIR, file), 'utf8')
    return file.endsWith('.toml') ? parseToml(text) : JSON.parse(text)
  } catch {
    return null
  }
}
async function loadServerConfig(): Promise<ServerConfig> {
  const parsed = ((await readConfigFile('config.toml')) ??
    (await readConfigFile('config.json'))) as { providers?: unknown } | null
  const p = parsed?.providers
  return { providers: p && typeof p === 'object' ? (p as ServerConfig['providers']) : {} }
}

function asGroup(x: unknown): Group | null {
  if (!x || typeof x !== 'object') return null
  const g = x as { id?: unknown; label?: unknown; segments?: unknown }
  if (typeof g.id !== 'string' || typeof g.label !== 'string' || !Array.isArray(g.segments)) {
    return null
  }
  return x as Group
}

// プラグイン autoload。manifest ({id, group}) 推奨。旧 function 形は filename を id にする。
// パス単位キャッシュ: ファイルを置けば再起動なしで次 poll から有効 (編集は再起動要)。
const loaded = new Map<string, ProviderDef>()
async function getUserProviders(): Promise<ProviderDef[]> {
  let files: string[]
  try {
    files = (await readdir(PROVIDER_DIR)).filter((f) => /\.(ts|mjs|js)$/.test(f))
  } catch {
    return [] // ディレクトリ無し
  }
  const paths = new Set(files.map((f) => join(PROVIDER_DIR, f)))
  for (const path of paths) {
    if (loaded.has(path)) continue
    try {
      const mod = (await import(pathToFileURL(path).href)) as { default?: unknown }
      const d = mod.default as { id?: unknown; group?: unknown } | (() => unknown) | undefined
      if (d && typeof d === 'object' && typeof d.id === 'string' && typeof d.group === 'function') {
        const fn = d.group as (ctx: ProviderCtx) => unknown
        loaded.set(path, { id: d.id, group: async (ctx) => asGroup(await fn(ctx)) })
      } else if (typeof d === 'function') {
        const fn = d as () => unknown
        const id = basename(path).replace(/\.(ts|mjs|js)$/, '') // legacy: filename を id に
        loaded.set(path, { id, group: async () => asGroup(await fn()) })
      } else {
        console.warn(`[providers] ${path}: default export が provider ({id,group}) ではありません`)
        continue
      }
      console.log(`[providers] loaded ${path}`)
    } catch (e) {
      console.warn(`[providers] ${path} の読み込みに失敗:`, e)
    }
  }
  for (const path of [...loaded.keys()]) if (!paths.has(path)) loaded.delete(path)
  return [...loaded.values()]
}

async function statusDoc(): Promise<StatusDoc> {
  const cfg = await loadServerConfig()
  const all = [...BUILTINS, ...(await getUserProviders())]
  const active = all.filter((p) => cfg.providers[p.id]?.enabled !== false) // 既定 ON
  const results = await Promise.allSettled(
    active.map((p) => p.group({ options: cfg.providers[p.id] ?? {} })),
  )
  const groups: Group[] = []
  for (const r of results) if (r.status === 'fulfilled' && r.value) groups.push(r.value)
  return { version: 1, ts: Date.now(), groups }
}

function devApiPlugin() {
  return {
    name: 'toolbar-dev-api',
    configureServer(server: ViteDevServer) {
      // 表示要素は /api/status に集約。claude/codex/usage は provider 内部で使う。
      const endpoints: Record<string, () => Promise<unknown>> = {
        '/api/machine': machineInfo,
        '/api/status': statusDoc,
      }
      for (const [path, handler] of Object.entries(endpoints)) {
        server.middlewares.use(path, async (_req, res) => {
          res.setHeader('Content-Type', 'application/json')
          try {
            res.end(JSON.stringify(await handler()))
          } catch (e) {
            // 詳細 (ローカルパス等) は LAN クライアントに返さずサーバーログへ。
            console.error(`[api] ${path} failed:`, e)
            res.statusCode = 500
            res.end(JSON.stringify({ error: 'internal error' }))
          }
        })
      }
    },
  }
}

export default defineConfig({
  server: { host: true },
  plugins: [devApiPlugin(), devDiagPlugin()],
})
