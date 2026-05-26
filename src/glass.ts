import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { emptyConfig, loadConfig, syncMachineWithStatus } from './config'
import { setGlassBattery } from './device-state'
import { buildViews, type GlassData, type GView, renderGlass } from './glass-render'
import { activateKeepAlive, deactivateKeepAlive } from './keep-alive'
import { getStatus, refresh as storeRefresh, subscribe } from './store'

// glass (G2 576×288) の描画。companion と同じ WebView 内で動くが bridge 経由で
// glass にだけ描く。純粋ロジックは glass-render.ts、ここは状態と bridge 配線。
// status の取得・ポーリングは共有 store が担い、glass は購読して再描画する。
const DISPLAY_W = 576
const DISPLAY_H = 288
const CONTAINER_ID = 1
const CONTAINER_NAME = 'toolbar'

let gbridge: EvenAppBridge | null = null
const data: GlassData = {
  config: emptyConfig(),
  status: null,
}
let views: GView[] = ['summary']
let idx = 0
let lastClickAt = 0
let clockTimer: ReturnType<typeof setTimeout> | null = null
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
  if (clockTimer) clearTimeout(clockTimer)
  clockTimer = null
  deviceUnsub?.()
  deviceUnsub = null
  storeUnsub?.()
  storeUnsub = null
  deactivateKeepAlive()
}

// HUD の時刻を分境界で更新する (再描画のみ、fetch なし)。
function tickClock(): void {
  refresh()
  const now = new Date()
  const ms = (60 - now.getSeconds()) * 1000 - now.getMilliseconds()
  clockTimer = setTimeout(tickClock, ms)
}

// グラス(G2) のバッテリーを取得・購読する。status は sn でグラスのものだけ採用する
// (onDeviceStatusChanged は ring 等 他デバイスでも発火しうるが model フィールドが無い)。
async function initDeviceBattery(bridge: EvenAppBridge): Promise<void> {
  try {
    const info = await bridge.getDeviceInfo()
    if (info) {
      glassesSn = info.sn
      setGlassBattery(info.status?.batteryLevel ?? null, info.status?.isCharging ?? false)
    }
  } catch {
    /* 取得不可は無視 (HUD は時刻/日付のみ表示) */
  }
  deviceUnsub = bridge.onDeviceStatusChanged((status) => {
    if (glassesSn && status.sn !== glassesSn) return // 他デバイス(ring 等)は無視
    setGlassBattery(status.batteryLevel ?? null, status.isCharging ?? false)
    refresh()
  })
}

// single click → summary、double click → 終了、swipe → ビュー巡回。
// click は sysEvent、swipe(scroll) は textEvent で届く (handle-input 修正済み設計)。
// ライフサイクル (foreground enter/exit, abnormal/system exit) も sysEvent で来るので、
// click 判定より先に分岐する (さもないと click 扱いされ summary に戻ってしまう)。
function onEvent(event: EvenHubEvent): void {
  const sys = event.sysEvent
  if (sys) {
    const et = sys.eventType
    if (et === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      void storeRefresh() // 復帰時に最新データへ更新 (store 経由)
      return
    }
    if (et === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      return // poller なので flush 不要 (keep-alive で生存)
    }
    if (et === OsEventTypeList.ABNORMAL_EXIT_EVENT || et === OsEventTypeList.SYSTEM_EXIT_EVENT) {
      cleanup()
      return
    }
    const now = Date.now()
    if (now - lastClickAt < 200) return // 連続発火の握りつぶし
    lastClickAt = now
    if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void gbridge?.shutDownPageContainer(1)
    } else {
      // single click (eventType 0 または simulator では undefined) → summary へ
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

// active マシンの config を status に合わせて in-memory sync する (永続化は companion 側)。
function syncActive(): void {
  const id = data.config.activeMachine
  const mc = id ? data.config.machines[id] : null
  if (mc && data.status) syncMachineWithStatus(mc, data.status)
}

// store の status 更新で再描画する。
function onStoreUpdate(): void {
  data.status = getStatus()
  syncActive()
  views = buildViews(data)
  if (idx >= views.length) idx = 0
  refresh()
}

// companion で設定変更 (saveConfig) されたら config を読み直して即再描画する。
async function onConfigChanged(): Promise<void> {
  data.config = await loadConfig()
  syncActive()
  views = buildViews(data)
  if (idx >= views.length) idx = 0
  refresh()
}

export async function initGlass(bridge: EvenAppBridge): Promise<void> {
  gbridge = bridge
  activateKeepAlive() // phone ロック / バックグラウンドでも WebView を生かす
  data.config = await loadConfig()
  data.status = getStatus() // store が既に取得済みなら反映 (companion が url 設定 + poll 起動済み)
  syncActive()
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
  storeUnsub = subscribe(onStoreUpdate) // status 更新を購読
  if (typeof window !== 'undefined') {
    window.addEventListener('toolbar:config-changed', () => void onConfigChanged())
    window.addEventListener('beforeunload', cleanup)
  }

  await initDeviceBattery(bridge) // HUD のグラスバッテリー
  tickClock() // HUD の時刻を分境界で更新
}
