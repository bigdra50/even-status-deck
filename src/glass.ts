import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { emptyConfig, loadConfig, syncSourceWithStatus } from './config'
import { setGlassBattery } from './device-state'
import { buildViews, type GlassData, type GView, renderGlass } from './glass-render'
import { activateKeepAlive, deactivateKeepAlive } from './keep-alive'
import { getAllStatuses, refreshBuiltins, refreshAll as storeRefresh, subscribe } from './store'

// glass (G2 576×288) の描画。複数ソースの status は共有 store が保持し、glass は購読して
// 横断描画する。HUD (時刻/電池) は builtin local の group として groupOrder に含まれる。
const DISPLAY_W = 576
const DISPLAY_H = 288
const CONTAINER_ID = 1
const CONTAINER_NAME = 'toolbar'

let gbridge: EvenAppBridge | null = null
const data: GlassData = {
  config: emptyConfig(),
  statuses: {},
}
let views: GView[] = ['summary']
let idx = 0
let lastClickAt = 0
let deviceUnsub: (() => void) | null = null
let storeUnsub: (() => void) | null = null
let glassesSn = '' // getDeviceInfo の sn。status 更新が他デバイス(ring 等)か判別する

function refresh(): void {
  void gbridge?.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      content: renderGlass(views[idx] ?? 'summary', data),
    }),
  )
}

function cycle(dir: number): void {
  if (views.length === 0) return
  idx = (idx + dir + views.length) % views.length
  refresh()
}

function cleanup(): void {
  deviceUnsub?.()
  deviceUnsub = null
  storeUnsub?.()
  storeUnsub = null
  deactivateKeepAlive()
}

// グラス(G2) のバッテリーを取得・購読する。status は sn でグラスのものだけ採用する
// (onDeviceStatusChanged は ring 等 他デバイスでも発火しうるが model フィールドが無い)。
// 電池更新時は builtin (HUD) を再計算させる。
async function initDeviceBattery(bridge: EvenAppBridge): Promise<void> {
  try {
    const info = await bridge.getDeviceInfo()
    if (info) {
      glassesSn = info.sn
      setGlassBattery(info.status?.batteryLevel ?? null, info.status?.isCharging ?? false)
      refreshBuiltins()
    }
  } catch {
    /* 取得不可は無視 (HUD は時刻/日付のみ表示) */
  }
  deviceUnsub = bridge.onDeviceStatusChanged((status) => {
    if (glassesSn && status.sn !== glassesSn) return // 他デバイス(ring 等)は無視
    setGlassBattery(status.batteryLevel ?? null, status.isCharging ?? false)
    refreshBuiltins() // HUD の電池を更新 → store notify → 再描画
  })
}

// single click → summary、double click → 終了、swipe → ビュー巡回。
// click は sysEvent、swipe(scroll) は textEvent。ライフサイクルも sysEvent で来るので
// click 判定より先に分岐する。
function onEvent(event: EvenHubEvent): void {
  const sys = event.sysEvent
  if (sys) {
    const et = sys.eventType
    if (et === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      void storeRefresh() // 復帰時に全ソース取り直し
      return
    }
    if (et === OsEventTypeList.FOREGROUND_EXIT_EVENT) return
    if (et === OsEventTypeList.ABNORMAL_EXIT_EVENT || et === OsEventTypeList.SYSTEM_EXIT_EVENT) {
      cleanup()
      return
    }
    const now = Date.now()
    if (now - lastClickAt < 200) return
    lastClickAt = now
    if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void gbridge?.shutDownPageContainer(1)
    } else {
      idx = 0
      refresh()
    }
    return
  }
  const txt = event.textEvent
  if (txt) {
    if (txt.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) cycle(1)
    else if (txt.eventType === OsEventTypeList.SCROLL_TOP_EVENT) cycle(-1)
  }
}

// 各ソースの status を config に in-memory sync (永続化は companion 側)。
function syncAll(): void {
  for (const [sourceId, status] of Object.entries(data.statuses)) {
    if (status) syncSourceWithStatus(data.config, sourceId, status)
  }
}

function onStoreUpdate(): void {
  data.statuses = getAllStatuses()
  syncAll()
  views = buildViews(data)
  if (idx >= views.length) idx = 0
  refresh()
}

async function onConfigChanged(): Promise<void> {
  data.config = await loadConfig()
  views = buildViews(data)
  if (idx >= views.length) idx = 0
  refresh()
}

export async function initGlass(bridge: EvenAppBridge): Promise<void> {
  gbridge = bridge
  activateKeepAlive() // phone ロック / バックグラウンドでも WebView を生かす
  data.config = await loadConfig()
  data.statuses = getAllStatuses() // store が既に取得済みなら反映 (companion が setSources 済み)
  syncAll()
  views = buildViews(data)
  idx = 0

  const text = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_W,
    height: DISPLAY_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 8,
    containerID: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    content: renderGlass(views[idx] ?? 'summary', data),
    isEventCapture: 1,
  })
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [text] }),
  )

  bridge.onEvenHubEvent(onEvent)
  storeUnsub = subscribe(onStoreUpdate)
  if (typeof window !== 'undefined') {
    window.addEventListener('toolbar:config-changed', () => void onConfigChanged())
    window.addEventListener('beforeunload', cleanup)
  }

  await initDeviceBattery(bridge) // HUD のグラスバッテリー (builtin に反映)
}
