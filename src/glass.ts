import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { loadBatteryLog, recordBatteryLevel, setBatteryBridge } from './battery'
import { clockShowsSeconds, localStatus } from './builtins'
import { BUILTIN_SOURCE_ID, emptyConfig, loadConfig, syncSourceWithStatus } from './config'
import { getGlassBattery, setGlassBattery } from './device-state'
import { compileGrid } from './glass-layout'
import {
  buildPopupOverlay,
  buildViews,
  type ExpView,
  GLASS_HEIGHT,
  GLASS_PADDING,
  GLASS_WIDTH,
  type GlassData,
  type GView,
  gridLayoutFor,
  POPUP_BASE_TEXT,
  POPUP_DEMO_NOTIFS,
  POPUP_DOT_CX,
  POPUP_MAX,
  type PopupNotif,
  popupDotYs,
  renderGlass,
} from './glass-render'
import { feedImuSample, isImuStarted, setImuConfig, startImu, stopImu } from './imu'
import { activateKeepAlive, deactivateKeepAlive } from './keep-alive'
import {
  getRenderableStatuses,
  refreshBuiltins,
  refreshAll as storeRefresh,
  subscribe,
} from './store'
import { computeVisible, resetVisibility, type VisibleMap } from './visibility'

// glass (G2 576×288) の描画。複数ソースの status は共有 store が保持し、glass は購読して
// 横断描画する。HUD (時刻/電池) は builtin local の group として groupOrder に含まれる。
const DISPLAY_W = GLASS_WIDTH
const DISPLAY_H = GLASS_HEIGHT
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
let eventUnsub: (() => void) | null = null // onEvenHubEvent の解除関数 (cleanup で確実に外す)
let glassesSn = '' // getDeviceInfo の sn。status 更新が他デバイス(ring 等)か判別する
let refreshBusy = false // bridge 書き込みを直列化 (BLE 飽和でグラス切断するのを防ぐ)
let refreshPending = false
let lastContent: string | null = null // 直近送信した content (single topology)。無変化なら upgrade 抑制
let lastTopo: string | null = null // 直近のコンテナ構成キー。変わると rebuildPageContainer する
let popupStack: PopupNotif[] = [] // popup 実験ページ: 表示中の通知スタック
let popupIdx = 0 // スタック内の現在表示 index (スクロールで移動)
let popupDemoNext = 0 // 次に push するデモ通知の index
let popupTimer: ReturnType<typeof setInterval> | null = null // 一定間隔で通知を push
const POPUP_INTERVAL_MS = 4000 // 通知の発生間隔
let glassClock: ReturnType<typeof setTimeout> | null = null // 分境界の時刻更新 (store.notify を介さない)

// 全面 1 text container (page1 / linear)。従来の単一コンテナと同一。
function singleContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_W,
    height: DISPLAY_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: GLASS_PADDING,
    containerID: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    content,
    isEventCapture: 1,
  })
}

function isPopupView(view: GView): boolean {
  return typeof view === 'object' && 'exp' in view && view.exp === 'popup'
}

// popup 実験ページのコンテナ: 表示中は overlay (上下1行 + 中央通知ボックス) を grid で、
// 非表示時は 10 行のトップページ (base) を単一コンテナで描く。
function popupContainers(): TextContainerProperty[] {
  if (popupStack.length === 0) return [singleContainer(POPUP_BASE_TEXT)]
  const grid = compileGrid(buildPopupOverlay(popupStack, popupIdx)).map(
    (c) => new TextContainerProperty(c),
  )
  // スタックドットは px 位置で中心を揃える (text 列だと narrow な · が左右にずれるため)。
  // 各ドットの中心を POPUP_DOT_CX に合わせ、glyph 幅の半分だけ左にずらして配置する。
  const ys = popupDotYs(popupStack.length)
  const dots = popupStack.map((_, i) => {
    const g = i === popupIdx ? '•' : '·'
    return new TextContainerProperty({
      xPosition: Math.round(POPUP_DOT_CX - getTextWidth(g) / 2),
      yPosition: ys[i] ?? 0,
      width: 16,
      height: 28,
      borderWidth: 0,
      borderColor: 0,
      paddingLength: 0,
      containerID: 90 + i,
      containerName: `dot${i}`,
      content: g,
      isEventCapture: 0,
    })
  })
  return [...grid, ...dots]
}

// view → グラスのコンテナ集合。popup → popupContainers、grid 実験 → compiler、
// それ以外 (summary / GroupRef / text 実験) → 単一 'toolbar' container。
function viewContainers(view: GView): TextContainerProperty[] {
  if (isPopupView(view)) return popupContainers()
  const layout = gridLayoutFor(view)
  if (layout) return compileGrid(layout).map((c) => new TextContainerProperty(c))
  return [singleContainer(renderGlass(view, data, visible))]
}

// topology キー (コンテナ構成の同一性)。popup は base/shown で別 (toggle で rebuild)、
// grid は id ごと、それ以外は 'single' (中身差し替えのみ)。
function topoKey(view: GView): string {
  // popup: stack 数 + 現在 index が変わると rebuild (ドット/中身が変わるため)。
  if (isPopupView(view))
    return popupStack.length === 0 ? 'popup:base' : `popup:${popupStack.length}:${popupIdx}`
  return gridLayoutFor(view) ? `grid:${(view as ExpView).exp}` : 'single'
}

// bridge 書き込みを 1 件ずつ直列化する (BLE 飽和でグラス切断するのを防ぐ。例外も握る)。
// topology が変われば rebuildPageContainer (ちらつき)、同一 single topology なら
// textContainerUpgrade (ちらつき無し・従来パス)。grid topology の中身更新は今は静的で no-op。
function refresh(): void {
  if (!gbridge) return
  if (refreshBusy) {
    refreshPending = true
    return
  }
  refreshBusy = true
  refreshPending = false
  const bridge = gbridge
  const done = (): void => {
    refreshBusy = false
    if (refreshPending) {
      refreshPending = false
      refresh()
    }
  }
  const view = views[idx] ?? 'summary'
  const key = topoKey(view)

  if (key !== lastTopo) {
    lastTopo = key
    let containers: TextContainerProperty[]
    try {
      containers = viewContainers(view)
    } catch (e) {
      console.error('[grid] compile failed:', e)
      containers = [singleContainer('(layout error)')]
    }
    lastContent = key === 'single' ? (containers[0]?.content ?? null) : null
    bridge
      .rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: containers.length, textObject: containers }),
      )
      .catch(() => {
        /* bridge 不通 — 次の更新で復帰 */
      })
      .finally(done)
    return
  }

  if (key === 'single') {
    const content = renderGlass(view, data, visible)
    if (content === lastContent) {
      done()
      return
    }
    lastContent = content
    bridge
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
      .finally(done)
    return
  }

  // 同一 grid topology: 静的 PoC なので再送不要 (内容は rebuild 時に確定)。
  // 将来データ束縛する際はここで per-container の textContainerUpgrade を行う。
  done()
}

function cycle(dir: number): void {
  if (views.length === 0) return
  idx = (idx + dir + views.length) % views.length
  refresh()
  syncPopupDemo()
}

// popup 実験ページにいる間だけ、一定間隔で popup を発生させるタイマーを回す。
// ページ離脱時はタイマーを止めて popup を畳む (他ページには影響しない)。
function syncPopupDemo(): void {
  if (isPopupView(views[idx] ?? 'summary')) {
    if (!popupTimer)
      popupTimer = setInterval(() => {
        if (popupStack.length < POPUP_MAX) {
          const n = POPUP_DEMO_NOTIFS[popupDemoNext % POPUP_DEMO_NOTIFS.length]
          if (n) popupStack.push(n)
          popupDemoNext++
          refresh()
        }
      }, POPUP_INTERVAL_MS)
  } else {
    if (popupTimer) {
      clearInterval(popupTimer)
      popupTimer = null
    }
    popupStack = []
    popupIdx = 0
  }
}

// 時刻 HUD を毎分更新する glass-local タイマー。er-clock 式: builtin status を直接再計算して
// refresh するだけ (store.notify を介さない = getAllStatuses/syncAll/computeVisible/buildViews を
// 毎分走らせない)。時刻変化では構成・可視は変わらないので views/visible はキャッシュのまま。
// refresh は content-diff 済みなので同分の再 arm では BLE 送信は起きない。
function glassTick(): void {
  data.statuses[BUILTIN_SOURCE_ID] = localStatus(data.config)
  refresh()
  scheduleGlassClock()
}

function scheduleGlassClock(): void {
  if (glassClock) clearTimeout(glassClock)
  const now = new Date()
  // 秒表示フォーマットなら次の秒境界、そうでなければ次の分境界に合わせる。
  // 秒表示時のみ毎秒 tick (それ以外は従来の毎分)。同分/同秒の再 arm は refresh の
  // content-diff が BLE 送信を抑制するので、無駄な textContainerUpgrade は起きない。
  const ms = clockShowsSeconds(data.config)
    ? 1000 - now.getMilliseconds()
    : (60 - now.getSeconds()) * 1000 - now.getMilliseconds()
  glassClock = setTimeout(glassTick, ms)
}

function cleanup(): void {
  eventUnsub?.()
  eventUnsub = null
  deviceUnsub?.()
  deviceUnsub = null
  storeUnsub?.()
  storeUnsub = null
  if (glassClock) {
    clearTimeout(glassClock)
    glassClock = null
  }
  if (popupTimer) {
    clearInterval(popupTimer)
    popupTimer = null
  }
  popupStack = []
  popupIdx = 0
  if (typeof window !== 'undefined') {
    window.removeEventListener('toolbar:config-changed', onConfigChangedEvent)
    window.removeEventListener('beforeunload', cleanup)
  }
  if (gbridge) void stopImu(gbridge)
  resetVisibility() // transient 状態 + wake タイマーを破棄
  deactivateKeepAlive()
  // exit 後に onStoreUpdate/onConfigChanged/refresh が bridge 書込を復活させないよう無効化。
  gbridge = null
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
    } else if (isPopupView(views[idx] ?? 'summary') && popupStack.length > 0) {
      // 表示中の通知を既読にして閉じ、次へ。空になれば base へ戻る。
      popupStack.splice(popupIdx, 1)
      if (popupIdx >= popupStack.length) popupIdx = Math.max(0, popupStack.length - 1)
      refresh()
    } else {
      idx = 0
      refresh()
      syncPopupDemo()
    }
    return
  }
  const txt = event.textEvent
  if (txt) {
    // popup スタック表示中はスクロールでスタック内を移動 (端では据え置き)。
    if (isPopupView(views[idx] ?? 'summary') && popupStack.length > 0) {
      if (txt.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT)
        popupIdx = Math.min(popupIdx + 1, popupStack.length - 1)
      else if (txt.eventType === OsEventTypeList.SCROLL_TOP_EVENT)
        popupIdx = Math.max(popupIdx - 1, 0)
      refresh()
      return
    }
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
  data.statuses = getRenderableStatuses() // offline の server source は除外 (古い値=嘘を出さない)
  data.statuses[BUILTIN_SOURCE_ID] = localStatus(data.config) // poll/電池 notify 時も時刻を最新に保つ
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

// window listener は名前付き参照で登録し、cleanup で確実に removeEventListener する。
const onConfigChangedEvent = (): void => void onConfigChanged()

export async function initGlass(bridge: EvenAppBridge): Promise<void> {
  gbridge = bridge
  activateKeepAlive() // phone ロック / バックグラウンドでも WebView を生かす
  data.config = await loadConfig()
  setBatteryBridge(bridge)
  await loadBatteryLog() // 消耗レートの永続ログを復元
  data.statuses = getRenderableStatuses() // store が既に取得済みなら反映 (offline は除外)
  data.statuses[BUILTIN_SOURCE_ID] = localStatus(data.config) // 時刻 HUD を初期表示
  syncAll()
  visible = computeVisible(data.config, data.statuses)
  views = buildViews(data, visible)
  idx = 0

  // 起動ページ。idx=0 = summary なので単一 'toolbar' container (従来どおり)。
  const view0 = views[idx] ?? 'summary'
  let initContainers: TextContainerProperty[]
  try {
    initContainers = viewContainers(view0)
  } catch {
    initContainers = [singleContainer('(layout error)')]
  }
  lastTopo = topoKey(view0)
  lastContent = lastTopo === 'single' ? (initContainers[0]?.content ?? null) : null
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: initContainers.length,
      textObject: initContainers,
    }),
  )

  eventUnsub = bridge.onEvenHubEvent(onEvent)
  storeUnsub = subscribe(onStoreUpdate)
  if (typeof window !== 'undefined') {
    window.addEventListener('toolbar:config-changed', onConfigChangedEvent)
    window.addEventListener('beforeunload', cleanup)
  }

  await initDeviceBattery(bridge) // HUD のグラスバッテリー (builtin に反映)
  await applyImuConfig() // config.imu.enabled なら IMU 起動 (onEvent 登録後・前提コンテナ作成後)
  scheduleGlassClock() // 時刻 HUD を毎分更新 (store.notify を介さない glass-local タイマー)
  syncPopupDemo() // idx=0 (summary) では no-op。popup ページに入ると timer 開始
}
