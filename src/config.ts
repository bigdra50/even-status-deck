import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { StatusDoc } from './status-types'

// 設定 (Machine > Source > Metric)。bridge.setLocalStorage にスマホ集約保存する。
// source = status の group、metric = group の segment に対応 (フィールド名は互換維持)。
export type MetricCfg = { id: string; enabled: boolean }
export type SourceCfg = { id: string; enabled: boolean; expanded: boolean; metrics: MetricCfg[] }
// url: 最後に接続成功した接続先 (起動時にデータ取得 base を復元するため永続化)
export type MachineCfg = { url?: string; sourceOrder: string[]; sources: Record<string, SourceCfg> }
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

// マシンが config に無ければ空で初期化して返す。中身は status から sync する。
export function ensureMachine(cfg: Config, machineId: string): MachineCfg {
  let mc = cfg.machines[machineId]
  if (!mc) {
    mc = { sourceOrder: [], sources: {} }
    cfg.machines[machineId] = mc
  }
  return mc
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
