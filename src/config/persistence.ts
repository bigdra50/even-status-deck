import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { bumpDiag } from '../diag-counters'
import { emptyConfig } from './defaults'
import { migrate } from './migration'
import type { Config } from './types'

const KEY = 'toolbar.config'

let bridge: EvenAppBridge | null = null
let memory: Config | null = null
// bridge ストレージを「信頼できる状態か」。最初に getLocalStorage が一度でも成功する
// (値あり/確実に空のどちらでも) まで 'unknown' のまま。'unknown' の間は setLocalStorage で
// 上書きしない: アップデート直後など host ストレージ準備前に getLocalStorage が transient に
// throw → emptyConfig フォールバック → 直後の save で本物を空で潰す、という全消失を防ぐ。
let bridgeState: 'unknown' | 'ready' = 'unknown'
// bridge への保存を直列化するチェイン。companion が連続トグルで await を外しても、
// 各タスクが最新 memory を書く + 書込み完了後に通知することで、古い JSON での上書きを防ぐ。
let saveChain: Promise<void> = Promise.resolve()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function setConfigBridge(b: EvenAppBridge): void {
  bridge = b
}

// bridge から 1 回 (失敗時はもう 1 回) 読む。戻り値 ok は「読み取りに成功したか」(値の有無では
// ない)。ok=false は transient 失敗 = この間は書き込み禁止。ok=true なら raw が null/'' でも
// 「確実に空」とみなして書き込みを解禁する (初回インストールの first save を通すため)。
async function readRaw(b: EvenAppBridge): Promise<{ ok: boolean; raw: string | null }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { ok: true, raw: await b.getLocalStorage(KEY) }
    } catch (e) {
      if (attempt === 0) {
        await sleep(150) // host ストレージ準備前の transient 失敗を 1 度だけ待って再試行
        continue
      }
      console.warn('[config] getLocalStorage failed after retry; not overwriting stored config', e)
    }
  }
  return { ok: false, raw: null }
}

export async function loadConfig(): Promise<Config> {
  if (bridge) {
    const { ok, raw } = await readRaw(bridge)
    if (ok) {
      bridgeState = 'ready' // 読めた (値あり or 確実に空) → 以後 setLocalStorage で書いて安全
      if (raw) {
        try {
          return migrate(JSON.parse(raw) as Record<string, unknown>)
        } catch (e) {
          // 保存値が壊れている (parse/migrate 不能)。読み取り自体は成功しているので書き込みは
          // 解禁したまま、空から作り直させる (旧挙動と同じ)。
          console.warn('[config] stored config is unparsable; starting from empty', e)
        }
      }
    }
  }
  return memory ?? emptyConfig()
}

export async function saveConfig(c: Config): Promise<void> {
  bumpDiag('save') // #4 定常状態計測: 定常状態で save が増えない事を実機で確認するため
  memory = c
  // bridge 不在 (ブラウザ dev / 未接続) または bridge 未確立 (読み取りがまだ成功していない):
  // メモリのみに保持し bridge へは書かない。準備前の空 config で永続側を潰さない。
  // glass/companion へは即時通知 (UI 反映)。
  if (!bridge || bridgeState !== 'ready') {
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
    } catch (e) {
      // 書き込み失敗は握り潰さずログ (memory には残る)。容量超過/一時失敗を可視化する。
      console.warn('[config] setLocalStorage failed; kept in memory only', e)
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toolbar:config-changed'))
    }
  })
  return saveChain
}

// テスト用: モジュール内のステート (bridge / memory / 確立フラグ / 直列チェイン) を初期化する。
// 本番経路からは呼ばない (bridge は setConfigBridge、状態は load/save が管理する)。
export function __resetConfigPersistenceForTest(): void {
  bridge = null
  memory = null
  bridgeState = 'unknown'
  saveChain = Promise.resolve()
}
