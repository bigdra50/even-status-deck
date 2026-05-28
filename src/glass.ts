import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { loadBatteryLog, recordBatteryLevel, setBatteryBridge } from './battery'
import { localStatus } from './builtins'
import { BUILTIN_SOURCE_ID, emptyConfig, loadConfig, syncSourceWithStatus } from './config'
import { getGlassBattery, setGlassBattery } from './device-state'
import { buildViews, type GlassData, type GView, renderGlass } from './glass-render'
import { feedImuSample, isImuStarted, setImuConfig, startImu, stopImu } from './imu'
import { activateKeepAlive, deactivateKeepAlive } from './keep-alive'
import { getAllStatuses, refreshBuiltins, refreshAll as storeRefresh, subscribe } from './store'
import { computeVisible, resetVisibility, type VisibleMap } from './visibility'

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
let visible: VisibleMap = new Map() // 表示タイミング条件の可視マップ (store/config 更新で再計算)
let idx = 0
let lastClickAt = 0
let deviceUnsub: (() => void) | null = null
let storeUnsub: (() => void) | null = null
let glassesSn = '' // getDeviceInfo の sn。status 更新が他デバイス(ring 等)か判別する
let refreshBusy = false // bridge 書き込みを直列化 (BLE 飽和でグラス切断するのを防ぐ)
let refreshPending = false
let lastContent: string | null = null // 直近送信した content。無変化なら textContainerUpgrade を抑制
let glassClock: ReturnType<typeof setTimeout> | null = null // 分境界の時刻更新 (store.notify を介さない)

// textContainerUpgrade を 1 件ずつ直列化する。書き込み中の追加要求は 1 つに畳む。
// (連続発火: 時刻/電池/poll/swipe 等が重なっても BLE をあふれさせない。例外も握る)
function refresh(): void {
  if (!gbridge) return
  if (refreshBusy) {
    refreshPending = true
    return
  }
  refreshBusy = true
  refreshPending = false
  const content = renderGlass(views[idx] ?? 'summary', data, visible)
  if (content === lastContent) {
    // 内容無変化: BLE/native churn を避けるため送らない (毎分 clock tick で時刻が同分なら起こりうる)
    refreshBusy = false
    if (refreshPending) {
      refreshPending = false
      refresh()
    }
    return
  }
  lastContent = content
  gbridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        content,
      }),
    )
    .catch(() => {
      /* bridge 不通/コンテナ無効 — 無視 (次の更新で復帰) */
    })
    .finally(() => {
      refreshBusy = false
      if (refreshPending) {
        refreshPending = false
        refresh()
      }
    })
}

function cycle(dir: number): void {
  if (views.length === 0) return
  idx = (idx + dir + views.length) % views.length
  refresh()
}

// 時刻 HUD を毎分更新する glass-local タイマー。er-clock 式: builtin status を直接再計算して
// refresh するだけ (store.notify を介さない = getAllStatuses/syncAll/computeVisible/buildViews を
// 毎分走らせない)。時刻変化では構成・可視は変わらないので views/visible はキャッシュのまま。
// refresh は content-diff 済みなので同分の再 arm では BLE 送信は起きない。
function glassTick(): void {
  data.statuses[BUILTIN_SOURCE_ID] = localStatus()
  refresh()
  scheduleGlassClock()
}

function scheduleGlassClock(): void {
  if (glassClock) clearTimeout(glassClock)
  const now = new Date()
  const ms = (60 - now.getSeconds()) * 1000 - now.getMilliseconds()
  glassClock = setTimeout(glassTick, ms)
}

function cleanup(): void {
  deviceUnsub?.()
  deviceUnsub = null
  storeUnsub?.()
  storeUnsub = null
  if (glassClock) {
    clearTimeout(glassClock)
    glassClock = null
  }
  if (gbridge) void stopImu(gbridge)
  resetVisibility() // transient 状態 + wake タイマーを破棄
  deactivateKeepAlive()
}

// config.imu に従い IMU を起動/停止する (enable アダプタ)。初期化時と config 変更時の両方から呼ぶ。
// IMU 方向は src/imu ライブラリが検出し onDirectionChange で配る。現状 consumer は未配線 (休眠)。
async function applyImuConfig(): Promise<void> {
  if (!gbridge) return
  const imu = data.config.imu
  if (imu?.enabled) {
    setImuConfig(imu) // axis/thresholds はランタイム反映
    if (!isImuStarted()) await startImu(gbridge, imu.pace)
  } else if (isImuStarted()) {
    await stopImu(gbridge)
  }
}

// グラス(G2) のバッテリーを取得・購読する。status は sn でグラスのものだけ採用する
// (onDeviceStatusChanged は ring 等 他デバイスでも発火しうるが model フィールドが無い)。
// 電池更新時は builtin (HUD) を再計算させる。
async function initDeviceBattery(bridge: EvenAppBridge): Promise<void> {
  try {
    const info = await bridge.getDeviceInfo()
    if (info) {
      glassesSn = info.sn
      const lvl = info.status?.batteryLevel ?? null
      const chg = info.status?.isCharging ?? false
      setGlassBattery(lvl, chg)
      if (lvl != null) recordBatteryLevel(lvl, chg, Date.now())
      refreshBuiltins()
    }
  } catch {
    /* 取得不可は無視 (HUD は時刻/日付のみ表示) */
  }
  deviceUnsub = bridge.onDeviceStatusChanged((status) => {
    if (glassesSn && status.sn !== glassesSn) return // 他デバイス(ring 等)は無視
    const lvl = status.batteryLevel ?? null
    const chg = status.isCharging ?? false
    const cur = getGlassBattery()
    if (cur.level === lvl && cur.charging === chg) return // 変化なしは無視 (notify storm 防止)
    setGlassBattery(lvl, chg)
    if (lvl != null) recordBatteryLevel(lvl, chg, Date.now()) // 消耗レート用ログ
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
    // IMU サンプルは click fallback より前に捌く (未知 sysEvent を click 扱いする下の分岐に
    // 落とすとビューリセット + BLE 洪水を起こすため)。
    if (et === OsEventTypeList.IMU_DATA_REPORT) {
      const d = sys.imuData
      if (d) feedImuSample({ x: d.x ?? 0, y: d.y ?? 0, z: d.z ?? 0 }, Date.now())
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
  data.statuses[BUILTIN_SOURCE_ID] = localStatus() // poll/電池 notify 時も時刻を最新に保つ
  syncAll()
  visible = computeVisible(data.config, data.statuses)
  views = buildViews(data, visible)
  if (idx >= views.length) idx = 0
  refresh()
}

async function onConfigChanged(): Promise<void> {
  data.config = await loadConfig()
  visible = computeVisible(data.config, data.statuses)
  views = buildViews(data, visible)
  if (idx >= views.length) idx = 0
  await applyImuConfig() // IMU トグル/設定変更を反映
  refresh()
}

export async function initGlass(bridge: EvenAppBridge): Promise<void> {
  gbridge = bridge
  activateKeepAlive() // phone ロック / バックグラウンドでも WebView を生かす
  data.config = await loadConfig()
  setBatteryBridge(bridge)
  await loadBatteryLog() // 消耗レートの永続ログを復元
  data.statuses = getAllStatuses() // store が既に取得済みなら反映 (companion が setSources 済み)
  data.statuses[BUILTIN_SOURCE_ID] = localStatus() // 時刻 HUD を初期表示
  syncAll()
  visible = computeVisible(data.config, data.statuses)
  views = buildViews(data, visible)
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
    content: renderGlass(views[idx] ?? 'summary', data, visible),
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
  await applyImuConfig() // config.imu.enabled なら IMU 起動 (onEvent 登録後・前提コンテナ作成後)
  scheduleGlassClock() // 時刻 HUD を毎分更新 (store.notify を介さない glass-local タイマー)
}
