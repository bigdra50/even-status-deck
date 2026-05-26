import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { DEFAULT_ENABLED_METRICS, sourceById } from './sources'

// 設定 (Machine > Source > Metric)。bridge.setLocalStorage にスマホ集約保存する。
export type MetricCfg = { id: string; enabled: boolean }
export type SourceCfg = { id: string; enabled: boolean; expanded: boolean; metrics: MetricCfg[] }
export type MachineCfg = { sourceOrder: string[]; sources: Record<string, SourceCfg> }
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
  return { version: 1, activeMachine: null, machines: {}, glassHints: true }
}

export async function loadConfig(): Promise<Config> {
  if (bridge) {
    try {
      const s = await bridge.getLocalStorage(KEY)
      if (s) return JSON.parse(s) as Config
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

// 接続先の availableSources から、そのマシンの初期設定を生成する。
export function defaultMachineCfg(available: string[]): MachineCfg {
  const order = available.slice()
  const sources: Record<string, SourceCfg> = {}
  for (const id of available) {
    const src = sourceById(id)
    if (!src) continue
    sources[id] = {
      id,
      enabled: true,
      expanded: false,
      metrics: src.metrics.map((m) => ({ id: m.id, enabled: DEFAULT_ENABLED_METRICS.has(m.id) })),
    }
  }
  return { sourceOrder: order, sources }
}

// マシンが config に無ければ初期化して返す。
export function ensureMachine(cfg: Config, machineId: string, available: string[]): MachineCfg {
  let mc = cfg.machines[machineId]
  if (!mc) {
    mc = defaultMachineCfg(available)
    cfg.machines[machineId] = mc
  }
  return mc
}
