import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { StatusDoc } from './status-types'

// 設定 (v3): 複数データソースを横断して描画する。source は builtin(client算出) か server(URL)。
// group/segment トグルと並び順を source 名前空間付きで保持する (codex 指摘: 不変ID + structured key)。
export const CONFIG_VERSION = 3
export const BUILTIN_SOURCE_ID = 'builtin.local'

export type SourceKind = 'builtin' | 'server'
export type SourceDef = { id: string; kind: SourceKind; label: string; url?: string }
export type SegCfg = { id: string; enabled: boolean }
export type GroupCfg = { enabled: boolean; expanded: boolean; segments: SegCfg[] }
export type GroupRef = { sourceId: string; groupId: string }
export type Config = {
  version: number
  sources: SourceDef[]
  groups: Record<string, Record<string, GroupCfg>> // sourceId -> groupId -> cfg (nested = delimiter 衝突なし)
  groupOrder: GroupRef[] // 全ソース横断の表示順
  glassHints: boolean
}

const KEY = 'toolbar.config'

let bridge: EvenAppBridge | null = null
let memory: Config | null = null

export function setConfigBridge(b: EvenAppBridge): void {
  bridge = b
}

export function genSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// builtin local ソース (時刻/電池) を必ず先頭に持たせる。
function ensureBuiltin(cfg: Config): void {
  if (!cfg.sources.some((s) => s.id === BUILTIN_SOURCE_ID)) {
    cfg.sources.unshift({ id: BUILTIN_SOURCE_ID, kind: 'builtin', label: '本体 (時刻/電池)' })
  }
  if (!cfg.groups[BUILTIN_SOURCE_ID]) cfg.groups[BUILTIN_SOURCE_ID] = {}
}

export function emptyConfig(): Config {
  const c: Config = {
    version: CONFIG_VERSION,
    sources: [],
    groups: {},
    groupOrder: [],
    glassHints: true,
  }
  ensureBuiltin(c)
  return c
}

export async function loadConfig(): Promise<Config> {
  let raw: string | null = null
  if (bridge) {
    try {
      raw = await bridge.getLocalStorage(KEY)
    } catch {
      /* fall through */
    }
  }
  if (raw) {
    try {
      return migrate(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      /* fall through */
    }
  }
  return memory ?? emptyConfig()
}

export async function saveConfig(c: Config): Promise<void> {
  memory = c
  if (bridge) {
    try {
      await bridge.setLocalStorage(KEY, JSON.stringify(c))
    } catch {
      /* bridge 不在/失敗時はメモリのみ */
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toolbar:config-changed'))
  }
}

// v1/v2 (machines マップ) -> v3。URL・トグル・並び順を保持。builtin を先頭に追加。
type OldMachine = {
  id?: string
  label?: string
  url?: string
  sourceOrder?: string[]
  sources?: Record<string, { enabled?: boolean; expanded?: boolean; metrics?: SegCfg[] }>
}
function migrate(parsed: Record<string, unknown>): Config {
  if (parsed.version === CONFIG_VERSION) {
    const c = parsed as unknown as Config
    ensureBuiltin(c)
    return c
  }
  const old = parsed as {
    machines?: Record<string, OldMachine>
    glassHints?: boolean
  }
  const cfg = emptyConfig()
  cfg.glassHints = old.glassHints ?? true
  for (const [mid, mc] of Object.entries(old.machines ?? {})) {
    const id = mc.id ?? genSourceId() // v2 の不変 ID は保持、v1 は新規採番
    cfg.sources.push({ id, kind: 'server', label: mc.label ?? mid, url: mc.url })
    const groups: Record<string, GroupCfg> = {}
    for (const [gid, scfg] of Object.entries(mc.sources ?? {})) {
      groups[gid] = {
        enabled: scfg.enabled ?? true,
        expanded: scfg.expanded ?? false,
        segments: (scfg.metrics ?? []).map((m) => ({ id: m.id, enabled: m.enabled ?? true })),
      }
    }
    cfg.groups[id] = groups
    for (const gid of mc.sourceOrder ?? []) cfg.groupOrder.push({ sourceId: id, groupId: gid })
  }
  return cfg
}

export function sourceById(cfg: Config, id: string): SourceDef | undefined {
  return cfg.sources.find((s) => s.id === id)
}

// 新規 server ソースを不変 ID で追加する。
export function addServer(cfg: Config, label: string, url?: string): SourceDef {
  const def: SourceDef = { id: genSourceId(), kind: 'server', label, url }
  cfg.sources.push(def)
  cfg.groups[def.id] = {}
  return def
}

// ソースを削除する (builtin は不可)。group 設定と groupOrder も掃除する。
export function removeSource(cfg: Config, id: string): void {
  if (id === BUILTIN_SOURCE_ID) return
  cfg.sources = cfg.sources.filter((s) => s.id !== id)
  delete cfg.groups[id]
  cfg.groupOrder = cfg.groupOrder.filter((r) => r.sourceId !== id)
}

// status を該当ソースの設定に反映する。新規 group/segment は既定追加 + groupOrder 末尾へ。
// 既存トグル・並び順は保持。追加があれば true。
export function syncSourceWithStatus(cfg: Config, sourceId: string, status: StatusDoc): boolean {
  let changed = false
  if (!cfg.groups[sourceId]) cfg.groups[sourceId] = {}
  const groups = cfg.groups[sourceId]
  for (const g of status.groups) {
    let gc = groups[g.id]
    if (!gc) {
      gc = { enabled: true, expanded: false, segments: [] }
      groups[g.id] = gc
      cfg.groupOrder.push({ sourceId, groupId: g.id })
      changed = true
    }
    for (const seg of g.segments) {
      if (!gc.segments.some((s) => s.id === seg.id)) {
        gc.segments.push({ id: seg.id, enabled: seg.defaultEnabled ?? true })
        changed = true
      }
    }
  }
  return changed
}
