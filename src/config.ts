import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { StatusDoc } from './status-types'

// 設定 (Machine/Source > Group > Metric/Segment)。bridge.setLocalStorage に永続化する。
// v2: machines を hostname 由来 machineId ではなく不変 ID (uuid) でキーする (codex 指摘)。
//   id/kind/label を持たせ、URL 変更・hostname 変更でも設定が孤児化しないようにする。
//   (source = status の group、metric = group の segment。フィールド名は互換維持)
export const CONFIG_VERSION = 2

export type MetricCfg = { id: string; enabled: boolean }
export type SourceCfg = { id: string; enabled: boolean; expanded: boolean; metrics: MetricCfg[] }
export type MachineCfg = {
  id: string // 不変 ID (map のキーと同じ)。hostname/URL から導出しない
  kind: 'server' | 'builtin'
  label: string
  url?: string // 最後に接続成功した接続先 (起動時に復元)
  sourceOrder: string[]
  sources: Record<string, SourceCfg>
}
export type Config = {
  version: number
  activeMachine: string | null
  machines: Record<string, MachineCfg>
  glassHints: boolean
}

const KEY = 'toolbar.config'

let bridge: EvenAppBridge | null = null
// bridge が無い環境 (ブラウザ単体 dev) 用のメモリフォールバック
let memory: Config | null = null

export function setConfigBridge(b: EvenAppBridge): void {
  bridge = b
}

export function emptyConfig(): Config {
  return { version: CONFIG_VERSION, activeMachine: null, machines: {}, glassHints: true }
}

export function genSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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
  // glass (glass.ts) に設定変更を通知して即再描画させる。
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toolbar:config-changed'))
  }
}

// v1 -> v2 移行: machineId キーを不変 ID へ再キー化。URL・トグル・並び順を保持する。
type V1Machine = {
  url?: string
  sourceOrder?: string[]
  sources?: Record<string, { enabled?: boolean; expanded?: boolean; metrics?: MetricCfg[] }>
}
function migrate(parsed: Record<string, unknown>): Config {
  if (parsed.version === CONFIG_VERSION) return parsed as unknown as Config
  const v1 = parsed as {
    activeMachine?: string | null
    machines?: Record<string, V1Machine>
    glassHints?: boolean
  }
  const cfg = emptyConfig()
  cfg.glassHints = v1.glassHints ?? true
  for (const [machineId, mc] of Object.entries(v1.machines ?? {})) {
    const id = genSourceId()
    const sources: Record<string, SourceCfg> = {}
    for (const [gid, scfg] of Object.entries(mc.sources ?? {})) {
      sources[gid] = {
        id: gid,
        enabled: scfg.enabled ?? true,
        expanded: scfg.expanded ?? false,
        metrics: (scfg.metrics ?? []).map((m) => ({ id: m.id, enabled: m.enabled ?? true })),
      }
    }
    cfg.machines[id] = {
      id,
      kind: 'server',
      label: machineId,
      url: mc.url,
      sourceOrder: (mc.sourceOrder ?? []).slice(),
      sources,
    }
    if (machineId === v1.activeMachine) cfg.activeMachine = id
  }
  return cfg
}

export function activeMachineCfg(cfg: Config): MachineCfg | null {
  return cfg.activeMachine ? (cfg.machines[cfg.activeMachine] ?? null) : null
}

// 新規 server ソースを不変 ID で作成し active にする。
export function addServer(cfg: Config, label: string, url?: string): MachineCfg {
  const id = genSourceId()
  const mc: MachineCfg = { id, kind: 'server', label, url, sourceOrder: [], sources: {} }
  cfg.machines[id] = mc
  cfg.activeMachine = id
  return mc
}

// active な server ソースの URL/label を更新する。無ければ作成する (ID は不変)。
export function upsertActiveServer(cfg: Config, url: string, label: string): MachineCfg {
  const active = activeMachineCfg(cfg)
  if (active && active.kind === 'server') {
    active.url = url
    active.label = label
    return active
  }
  return addServer(cfg, label, url)
}

// status の groups/segments を config に反映する。新規 group/segment は既定で追加し、
// 既存のトグル・並び順は保持する (消えた group は再接続で戻るため掃除しない)。
// 追加が発生したら true を返す (呼び出し側が保存要否を判断する)。
export function syncMachineWithStatus(mc: MachineCfg, status: StatusDoc): boolean {
  let changed = false
  for (const g of status.groups) {
    let scfg = mc.sources[g.id]
    if (!scfg) {
      scfg = { id: g.id, enabled: true, expanded: false, metrics: [] }
      mc.sources[g.id] = scfg
      if (!mc.sourceOrder.includes(g.id)) mc.sourceOrder.push(g.id)
      changed = true
    }
    for (const seg of g.segments) {
      if (!scfg.metrics.some((m) => m.id === seg.id)) {
        scfg.metrics.push({ id: seg.id, enabled: seg.defaultEnabled ?? true })
        changed = true
      }
    }
  }
  return changed
}
