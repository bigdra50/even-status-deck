// 集約層。builtin provider + JS autoload provider + subprocess provider をディスパッチし、
// /api/status のワイヤ型 StatusDoc に集約する (vite.config.ts:413-507 の移植・統合)。
//
// builtin: claude-code / codex / system (SYSTEM_GROUP_ID)。
// JS autoload: $XDG_CONFIG_HOME/eveng2-toolbar/providers/*.{ts,mjs,js} を pathToFileURL で動的 import。
//   OD-2 (配布=clone + `bun run server`) のため、autoload は runtime で常に有効
//   (compile バイナリ向けの IS_COMPILED 無効化は入れない)。
// subprocess: config.providers[id].command がある場合に runSubprocess へ委譲する (PROTOCOL §9c)。
//
// I-4 / Issue7 解決: builtin・subprocess の両方に TTL キャッシュ + inflight Promise dedup を適用し、
// 同時 /api/status 多発でも codex (9s spawn) / subprocess を 1 回しか spawn しないようにする。
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONFIG_DIR, PROVIDER_DIR } from './config.ts'
import { claudeProvider } from './providers/claude.ts'
import { codexProvider } from './providers/codex.ts'
import { SYSTEM_GROUP_ID, systemProvider } from './providers/system.ts'
import { runSubprocess } from './subprocess.ts'
import type {
  Group,
  ProviderCtx,
  ProviderDef,
  ServerConfig,
  StatusDoc,
  SubprocessEntry,
} from './types.ts'

// builtin provider の manifest。id を a-priori に持つことで計算前に config の enabled を適用できる。
const BUILTINS: ProviderDef[] = [
  { id: 'claude-code', group: claudeProvider },
  { id: 'codex', group: codexProvider },
  { id: SYSTEM_GROUP_ID, group: systemProvider },
]

// builtin provider 別の TTL (ms)。codex は 1 回 9s 程度かかる spawn なので 60s キャッシュ。
// それ以外 (claude/system) は計算が軽いので短く保ち、主目的は inflight dedup。
const BUILTIN_TTL_MS: Record<string, number> = {
  codex: 60_000,
}
const DEFAULT_BUILTIN_TTL_MS = 5_000
// subprocess provider の TTL 既定 (cfg.ttlMs 未指定時)。
const DEFAULT_SUBPROCESS_TTL_MS = 30_000

// --- JS plugin autoload --------------------------------------------------------------
// 受信値を Group として検証する (vite.config.ts:452-459 の単一 Group 検証を移植)。
function asGroup(x: unknown): Group | null {
  if (!x || typeof x !== 'object') return null
  const g = x as { id?: unknown; label?: unknown; segments?: unknown }
  if (typeof g.id !== 'string' || typeof g.label !== 'string' || !Array.isArray(g.segments)) {
    return null
  }
  return x as Group
}

// パス単位キャッシュ。ファイルを置けば再起動なしで次 poll から有効 (編集の反映は再起動要)。
// この Map は status.ts が所有する (移植元は vite.config.ts:463 のモジュールスコープ)。
const loaded = new Map<string, ProviderDef>()

// 1 つの provider ファイルを import して ProviderDef にする。manifest ({id, group}) を推奨。
// 旧 function 形 (default が関数) は filename=id 前提なので expectedId を採用 (legacy・deprecated)。
async function importProvider(path: string, expectedId: string): Promise<ProviderDef | null> {
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown }
  const d = mod.default as { id?: unknown; group?: unknown } | (() => unknown) | undefined
  if (d && typeof d === 'object' && typeof d.id === 'string' && typeof d.group === 'function') {
    const fn = d.group as (ctx: ProviderCtx) => unknown
    const disp = (d as { dispose?: unknown }).dispose
    return {
      id: d.id,
      group: async (ctx) => asGroup(await fn(ctx)),
      dispose: typeof disp === 'function' ? (disp as () => void | Promise<void>) : undefined,
    }
  }
  if (typeof d === 'function') {
    const fn = d as () => unknown
    console.warn(
      `[providers] ${path}: legacy function provider は deprecated。manifest {id, group} を使ってください`,
    )
    return { id: expectedId, group: async () => asGroup(await fn()) }
  }
  console.warn(`[providers] ${path}: default export が provider ({id,group}) ではありません`)
  return null
}

// JS plugin を autoload する。
//
// gate (C-1 / OD-A): 「providers/ に置けば動く」は廃止。**明示登録された id の `<id>.<ext>` だけを import する**。
// 未登録のファイルは一切 import しない (= top-level コードも走らない)。これにより sync ツールや
// malware が providers/ に置いただけのファイルは実行されない。登録 = config セクション or ledger
// 注入 (cfg.providers[id] が存在し、builtin でも subprocess でもないこと)。ファイル名は id に一致させる。
async function getUserProviders(cfg: ServerConfig): Promise<ProviderDef[]> {
  const builtinIds = new Set(BUILTINS.map((b) => b.id))
  // 登録済みのうち builtin でも subprocess (command 持ち) でもなく、無効化されていない id = JS plugin。
  // enabled=false は import もしない (top-level 副作用も走らせない)。再 enable で次回 import される。
  const jsIds = Object.entries(cfg.providers)
    .filter(
      ([id, opts]) => !builtinIds.has(id) && !isSubprocessEntry(opts) && opts?.enabled !== false,
    )
    .map(([id]) => id)

  // providers/ の <basename>.<ext> → path。`.tmp-*` (install ステージング) は除外。決定的に扱う。
  const byName = new Map<string, string>()
  try {
    for (const f of (await readdir(PROVIDER_DIR)).sort()) {
      const m = /^(?!\.tmp-)(.+)\.(ts|mjs|js)$/.exec(f)
      if (m?.[1] && !byName.has(m[1])) byName.set(m[1], join(PROVIDER_DIR, f))
    }
  } catch {
    // ディレクトリ無し → JS plugin 無し
  }

  const out: ProviderDef[] = []
  const usedPaths = new Set<string>()
  for (const id of jsIds) {
    const path = byName.get(id) // 登録 id に一致するファイルのみ (未登録ファイルは触らない)
    if (!path) continue // 登録あるがファイル無し (無害にスキップ)
    usedPaths.add(path)
    let def = loaded.get(path)
    if (!def) {
      try {
        const imported = await importProvider(path, id)
        if (!imported) continue
        def = imported
        loaded.set(path, def)
        console.log(`[providers] loaded ${path}`)
      } catch (e) {
        console.warn(`[providers] ${path} の読み込みに失敗:`, e)
        continue
      }
    }
    if (def.id !== id) {
      console.warn(
        `[providers] ${path}: manifest id '${def.id}' が登録 id '${id}' と不一致 (ファイル名=id にしてください)`,
      )
      continue
    }
    out.push(def)
  }
  // 参照されなくなった (ファイル削除 / 登録解除) loaded を片付ける。dispose で timer/socket を解放。
  for (const path of [...loaded.keys()]) {
    if (usedPaths.has(path)) continue
    const d = loaded.get(path)
    if (d?.dispose) Promise.resolve(d.dispose()).catch(() => {}) // 解放失敗は無視
    loaded.delete(path)
  }
  return out
}

// --- TTL キャッシュ + inflight dedup --------------------------------------------------
const ttlCache = new Map<string, { group: Group; at: number }>()
const inflight = new Map<string, Promise<Group | null>>()

// id 単位で TTL キャッシュと同時実行 dedup を効かせて run を 1 回に集約する。
// builtin (codex 9s spawn) と subprocess の両方に適用する (I-4 / Issue7)。
function dedup(id: string, ttlMs: number, run: () => Promise<Group | null>): Promise<Group | null> {
  const hit = ttlCache.get(id)
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.group)
  const existing = inflight.get(id)
  if (existing) return existing // 同時リクエストは 1 spawn に集約
  const p = run()
    .then((g) => {
      if (g) ttlCache.set(id, { group: g, at: Date.now() })
      return g
    })
    .finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}

// config エントリが subprocess provider (command を持つ) かどうか。
function isSubprocessEntry(opts: unknown): opts is SubprocessEntry {
  return (
    !!opts &&
    typeof opts === 'object' &&
    typeof (opts as { command?: unknown }).command === 'string'
  )
}

// --- 集約 ------------------------------------------------------------------------------
// 1 つの provider (builtin/JS または subprocess) を解決して Group | null を返す。
function resolveProvider(
  id: string,
  builtin: ProviderDef | undefined,
  opts: ServerConfig['providers'][string] | undefined,
): Promise<Group | null> {
  // command があれば subprocess を優先 (config で外部コマンドに差し替えられる)。
  if (isSubprocessEntry(opts)) {
    const ttlMs = opts.ttlMs ?? DEFAULT_SUBPROCESS_TTL_MS
    return dedup(id, ttlMs, async () => {
      const result = await runSubprocess(id, opts, CONFIG_DIR)
      return result.ok ? result.group : null
    })
  }
  if (!builtin) return Promise.resolve(null)
  const ttlMs = BUILTIN_TTL_MS[id] ?? DEFAULT_BUILTIN_TTL_MS
  return dedup(id, ttlMs, async () => builtin.group({ options: opts ?? {} }))
}

// builtin + JS autoload + config 由来の subprocess provider を集約して StatusDoc を返す。
// enabled 既定 ON (未指定/true は実行、false のみ除外)。Promise.allSettled で 1 つの失敗が
// 他 provider を巻き込まないようにする。
export async function buildStatusDoc(cfg: ServerConfig): Promise<StatusDoc> {
  const builtins = [...BUILTINS, ...(await getUserProviders(cfg))]
  const byId = new Map(builtins.map((p) => [p.id, p]))

  // 実行対象 id を集める: builtin/JS の id と、config に command を持つ subprocess の id。
  const ids = new Set<string>(byId.keys())
  for (const [id, opts] of Object.entries(cfg.providers)) {
    if (isSubprocessEntry(opts)) ids.add(id)
  }

  const active = [...ids].filter((id) => cfg.providers[id]?.enabled !== false)
  const results = await Promise.allSettled(
    active.map((id) => resolveProvider(id, byId.get(id), cfg.providers[id])),
  )

  const groups: Group[] = []
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) groups.push(r.value)
  }
  return { version: 1, ts: Date.now(), groups }
}
