import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { bumpDiag } from '../diag-counters'
import { emptyConfig } from './defaults'
import { migrate } from './migration'
import type { Config } from './types'

const KEY = 'toolbar.config'

let bridge: EvenAppBridge | null = null
let memory: Config | null = null
// bridge への保存を直列化するチェイン。companion が連続トグルで await を外しても、
// 各タスクが最新 memory を書く + 書込み完了後に通知することで、古い JSON での上書きを防ぐ。
let saveChain: Promise<void> = Promise.resolve()

export function setConfigBridge(b: EvenAppBridge): void {
  bridge = b
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
  bumpDiag('save') // #4 定常状態計測: 定常状態で save が増えない事を実機で確認するため
  memory = c
  if (!bridge) {
    // bridge 不在 (ブラウザ dev / 未接続): メモリのみ。glass/companion へ即時通知。
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toolbar:config-changed'))
    }
    return
  }
  // 書込みを直列化し、各タスクは最新 memory を書く (古い JSON での上書き防止)。
  // config-changed は書込み完了後に発火する。発火を書込み前に出すと glass の loadConfig が
  // bridge から stale を読むため (glass.ts onConfigChanged は getLocalStorage で再読込する)。
  saveChain = saveChain.then(async () => {
    try {
      await bridge?.setLocalStorage(KEY, JSON.stringify(memory))
    } catch {
      /* bridge 失敗時はメモリのみ */
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toolbar:config-changed'))
    }
  })
  return saveChain
}
