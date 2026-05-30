import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { mountCompanion, onCompanionBridgeReady, setCompanionBridge } from './companion'
import { setConfigBridge } from './config'
import { initGlass } from './glass'
import './styles.css'

async function main() {
  // companion (スマホ WebView UI) は bridge 不要 (API fetch + config)。先に mount する。
  const app = document.getElementById('app')
  if (app) await mountCompanion(app)

  // bridge は glass 描画 (Phase2 ④) と config の永続化 (setLocalStorage) に使う。
  // ブラウザ単体では resolve しないため UI を止めないよう後回しにする。
  try {
    const bridge = await waitForEvenAppBridge()
    setConfigBridge(bridge)
    setCompanionBridge(bridge) // User プローブ (getUserInfo) 用にコンソールへ渡す
    await onCompanionBridgeReady() // 永続 config を読み直し前回の接続先を復元
    await initGlass(bridge) // glass に summary/claude/codex を SDK 描画
  } catch {
    // simulator / Even App 以外ではメモリフォールバック (config.ts)
  }
}

main()
