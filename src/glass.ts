import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { loadBatteryLog, recordBatteryLevel, setBatteryBridge } from './battery'
import { clockShowsSeconds, localStatus } from './builtins'
import {
  BUILTIN_SOURCE_ID,
  emptyConfig,
  enabledSources,
  LOCATION_SOURCE_ID,
  loadConfig,
  sourceUrls,
  syncSourceWithStatus,
} from './config'
import { postDialogResult } from './data'
import { getGlassBattery, setGlassBattery } from './device-state'
import { startEvents, stopEvents } from './events'
import { type CompiledCell, compileStatusLine } from './glass-layout'
import { createOverlayManager, hashStr, type Notif } from './glass-overlay'
import {
  buildRuntimePages,
  compileGridPage,
  currentPage,
  type GlassData,
  gridPageOf,
  gridPageText,
  MAX_ROWS,
  type RuntimePage,
  renderRuntimePage,
} from './glass-render'
import { createContainerSync } from './glass-sync'
import { feedImuSample, isImuStarted, setImuConfig, startImu, stopImu } from './imu'
import { activateKeepAlive, deactivateKeepAlive } from './keep-alive'
import {
  getRenderableStatuses,
  refreshBuiltins,
  refreshAll as storeRefresh,
  subscribe,
} from './store'
import {
  type ConditionDisplayRuntime,
  createConditionDisplayRuntime,
  createVisibilityRuntime,
  type DisplayResult,
  type VisibilityRuntime,
  type VisibleMap,
} from './visibility'
import { recomputeSunCountdown } from './weather'

// glass (G2 576×288) の描画。複数ソースの status は共有 store が保持し、glass は購読して
// 横断描画する。HUD (時刻/電池) は builtin local の group として groupOrder に含まれる。
const DEFAULT_DISPLAY_MS = 5000 // 条件提示 (toast/notification) の既定 自動非表示 ms (companion の既定秒数と一致)

let gbridge: EvenAppBridge | null = null
const data: GlassData = {
  config: emptyConfig(),
  statuses: {},
}
let pages: RuntimePage[] = [{ kind: 'autoSummary' }]
let visible: VisibleMap = new Map() // 表示タイミング条件の可視マップ (store/config 更新で再計算)
let idx = 0
let lastClickAt = 0
let deviceUnsub: (() => void) | null = null
let storeUnsub: (() => void) | null = null
let eventUnsub: (() => void) | null = null // onEvenHubEvent の解除関数 (cleanup で確実に外す)
let glassesSn = '' // getDeviceInfo の sn。status 更新が他デバイス(ring 等)か判別する
let refreshBusy = false // bridge 書き込みを直列化 (BLE 飽和でグラス切断するのを防ぐ)
let refreshPending = false
let lastOverlayKey: string | null = null // 直近の overlay 構成キー (種類+内容+下地 hash)。変わると rebuild
let glassClock: ReturnType<typeof setTimeout> | null = null // 分境界の時刻更新 (store.notify を介さない)
let overlayTimer: ReturnType<typeof setTimeout> | null = null // toast の自動消去タイマー
const overlay = createOverlayManager() // notification / toast / dialog / banner (server イベント用も含む)
// glass 専用の visibility runtime (companion preview と state を共有しない = edge 取りこぼし防止)。
const glassVisibility: VisibilityRuntime = createVisibilityRuntime({ wake: true })
// 条件成立 → overlay UI 提示 (edge/level)。glass のみ。
const displayRuntime: ConditionDisplayRuntime = createConditionDisplayRuntime()

// 通常ビューのコンテナ集合 (applied-state 同期は glass-sync)。送信は成功 (true) 後にのみ
// state を確定し、false / 例外は invalidate → 次回 rebuild (bridge 不通からの自動復帰)。
const sync = createContainerSync({
  rebuild: (cells) =>
    gbridge
      ? gbridge
          .rebuildPageContainer(
            new RebuildPageContainer({
              containerTotalNum: cells.length,
              textObject: cells.map((c) => new TextContainerProperty(c)),
            }),
          )
          .then((ok) => !!ok)
          .catch(() => false)
      : Promise.resolve(false),
  upgrade: (t) =>
    gbridge
      ? gbridge
          .textContainerUpgrade(new TextContainerUpgrade(t))
          .then((ok) => !!ok)
          .catch(() => false)
      : Promise.resolve(false),
})

// 現在ページのコンテナ集合と、その平文表現 (overlay の下地/コンテキスト行用)。
// linear/auto ページ = 全面 1 cell (status-line preset)。grid ページ = セル別コンテナ。
// 絵文字 tofu 対策の sanitize は glass-render(値/ラベル段) と glass-overlay(本文段) が担う。
function renderCurrentCells(): { cells: CompiledCell[]; base: string } {
  const page = currentPage(pages, idx)
  const grid = gridPageOf(page)
  if (grid) {
    return { cells: compileGridPage(grid, data, visible), base: gridPageText(grid, data, visible) }
  }
  const base = renderRuntimePage(page, data, MAX_ROWS, visible)
  return { cells: [compileStatusLine(base)], base }
}

// bridge 書き込みを 1 件ずつ直列化する (BLE 飽和でグラス切断するのを防ぐ。例外も握る)。
// 通知 popup がある間は現在ビューの上下 1 行を残し中央に overlay を rebuild、無ければ
// 現在ビューのコンテナ集合へ同期する (同一内容は無送信 / 1 セル差分は upgrade = ちらつき無し)。
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
  overlay.tick(Date.now()) // toast の expiry を進める (空になることもある)
  scheduleOverlayWake() // 次の自動消去をスケジュール
  // #38 suncountdown: location doc の weather group の残り時間 segment を描画時刻で再計算する
  // (glass-local clone, store 非変更)。recomputeSunCountdown は group id 'weather' を doc 内から探す。
  // 毎分 glassTick の refresh で値が減る。anchors/suncountdown が無ければ no-op。
  const loc = data.statuses[LOCATION_SOURCE_ID]
  if (loc) data.statuses[LOCATION_SOURCE_ID] = recomputeSunCountdown(loc, Date.now())
  const { cells, base } = renderCurrentCells()

  if (overlay.isActive()) {
    // 現在ビューの上に active overlay を重ねる。key に下地 (base) の hash も含め、
    // overlay 表示中のコンテキスト行/toast 下地の値更新でも再描画する。
    const key = `ov:${overlay.key()}:${hashStr(base)}`
    if (key !== lastOverlayKey) {
      lastOverlayKey = key
      sync.invalidate() // overlay が別コンテナ集合を送る → 通常ビューの applied state は無効
      const containers = overlay.containers(base)
      bridge
        .rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: containers.length,
            textObject: containers,
          }),
        )
        .catch(() => {})
        .finally(done)
    } else {
      done()
    }
    return
  }

  lastOverlayKey = null
  void sync.apply(cells).finally(done)
}

function cycle(dir: number): void {
  if (pages.length === 0) return
  idx = (idx + dir + pages.length) % pages.length
  refresh()
}

// toast の auto-dismiss 用タイマー。overlay.nextWakeMs() に合わせて setTimeout する。
function scheduleOverlayWake(): void {
  if (overlayTimer) {
    clearTimeout(overlayTimer)
    overlayTimer = null
  }
  const ms = overlay.nextWakeMs(Date.now())
  if (ms !== Number.POSITIVE_INFINITY) {
    overlayTimer = setTimeout(
      () => {
        overlayTimer = null
        refresh()
      },
      Math.max(0, ms),
    )
  }
}

// 外部トリガ: window 'toolbar:overlay' イベントで overlay を出す (通知ソースが決まったら繋ぐ)。
// detail.kind で notification(既定) / toast / dialog / banner を振り分ける。
type OverlayEvent =
  | ({ kind?: 'notification'; durationMs?: number } & Notif)
  | { kind: 'toast'; text: string; durationMs?: number }
  | {
      kind: 'dialog'
      title: string
      message: string
      actions?: string[]
      requestId?: string // リモート dialog のみ: 応答相関 ID
      replyUrl?: string // リモート dialog のみ: 応答 POST 先 (source の base URL)
    }
  | { kind: 'banner'; text: string }
function onOverlayEvent(e: Event): void {
  const d = (e as CustomEvent<OverlayEvent>).detail
  if (!d) return
  if (d.kind === 'toast') overlay.toast(d.text, { durationMs: d.durationMs })
  else if (d.kind === 'dialog') {
    const actions = d.actions?.length ? d.actions : ['OK']
    const { requestId, replyUrl } = d
    // リモート dialog (requestId+replyUrl 付き) は選択を source へ返す。ローカル発火は onResult なし。
    const onResult =
      requestId && replyUrl
        ? (index: number): void => {
            void postDialogResult(replyUrl, requestId, index, actions[index] ?? '')
          }
        : undefined
    overlay.dialog(d.title, d.message, actions, { onResult })
  } else if (d.kind === 'banner') overlay.setBanner(d.text)
  else overlay.notify(d, { durationMs: d.durationMs }) // durationMs 指定の host 通知は自動消去 (未指定=手動)
  refresh()
}

// config から server source の (id, urls) を抽出し、overlay イベント long-poll を張り直す。
// events 側が capabilities.events を広告しない source は long-poll しない (jettison/電池対策)。
function syncEventSources(): void {
  const sources = enabledSources(data.config)
    .filter((s) => s.kind === 'server')
    .map((s) => ({ id: s.id, urls: sourceUrls(s) }))
  startEvents(sources)
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
  overlay.clear()
  stopEvents() // overlay イベント long-poll を全停止
  if (overlayTimer) {
    clearTimeout(overlayTimer)
    overlayTimer = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('toolbar:config-changed', onConfigChangedEvent)
    window.removeEventListener('toolbar:overlay', onOverlayEvent)
    window.removeEventListener('beforeunload', cleanup)
  }
  if (gbridge) void stopImu(gbridge)
  glassVisibility.reset() // transient 状態 + wake タイマーを破棄
  displayRuntime.reset() // edge/banner 状態を破棄
  sync.invalidate() // 適用済みコンテナ state を破棄 (再 init 時に必ず作り直す)
  lastOverlayKey = null
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
    } else if (overlay.handleTap()) {
      // overlay が tap を消費 (dialog 確定 / 通知既読→次 / toast dismiss / banner 消去)。
      refresh()
    } else {
      // overlay 非アクティブ時のタップは summary に戻す。
      idx = 0
      refresh()
    }
    return
  }
  const txt = event.textEvent
  if (txt) {
    const dir =
      txt.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT
        ? 1
        : txt.eventType === OsEventTypeList.SCROLL_TOP_EVENT
          ? -1
          : 0
    if (dir === 0) return
    // overlay が scroll を消費 (dialog 選択 / 通知切替) すれば再描画、無ければビュー巡回。
    if (overlay.handleScroll(dir)) refresh()
    else cycle(dir)
  }
}

// 各ソースの status を config に in-memory sync (永続化は companion 側)。
function syncAll(): void {
  for (const [sourceId, status] of Object.entries(data.statuses)) {
    if (status) syncSourceWithStatus(data.config, sourceId, status)
  }
}

// 提示先 segment の文言を live status から解決する。custom text 優先、無ければ "label value" 自動合成。
function resolveDisplayText(f: {
  sourceId: string
  groupId: string
  segId: string
  text?: string
}): {
  label: string
  value: string
  text: string
} {
  const seg = data.statuses[f.sourceId]?.groups
    .find((g) => g.id === f.groupId)
    ?.segments.find((s) => s.id === f.segId)
  const label = seg?.label || f.segId
  const value = seg?.value ?? ''
  return { label, value, text: f.text ?? `${label} ${value}`.trim() }
}

function sourceLabelOf(sourceId: string, groupId: string): string {
  const src = data.config.sources.find((s) => s.id === sourceId)?.label
  if (src) return src
  return data.statuses[sourceId]?.groups.find((g) => g.id === groupId)?.label || sourceId
}

// 条件成立の提示を overlay へ反映する。edge fire は toast/notification/dialog、banner は level。
// refresh は呼び出し側 (onStoreUpdate 等) が行う。overlay.key() の content-hash が無駄な再描画を防ぐ。
function applyDisplay(dr: DisplayResult): void {
  for (const f of dr.fires) {
    const { label, value, text } = resolveDisplayText(f)
    // 既定 5s。toast/notification とも自動消去させる (durationMs 未設定の config でも notification が
    // 手動のまま残らないように。companion の既定秒数表示とも一致)。
    const durationMs = f.durationMs ?? DEFAULT_DISPLAY_MS
    if (f.ui === 'toast') overlay.toast(text, { durationMs })
    else {
      overlay.notify(
        { app: sourceLabelOf(f.sourceId, f.groupId), sender: label, body: f.text ?? value },
        { durationMs },
      )
    }
  }
}

function onStoreUpdate(): void {
  data.statuses = getRenderableStatuses() // offline の server source は除外 (古い値=嘘を出さない)
  data.statuses[BUILTIN_SOURCE_ID] = localStatus(data.config) // poll/電池 notify 時も時刻を最新に保つ
  syncAll()
  const r = glassVisibility.compute(data.config, data.statuses)
  visible = r.map
  applyDisplay(displayRuntime.observe(data.config, r.truthMap)) // 世界の変化のみ発火
  pages = buildRuntimePages(data, visible)
  if (idx >= pages.length) idx = 0
  refresh()
}

async function onConfigChanged(): Promise<void> {
  data.config = await loadConfig()
  const r = glassVisibility.compute(data.config, data.statuses)
  visible = r.map
  applyDisplay(displayRuntime.seed(data.config, r.truthMap)) // config 編集では発火させない (seed)
  pages = buildRuntimePages(data, visible)
  if (idx >= pages.length) idx = 0
  await applyImuConfig() // IMU トグル/設定変更を反映
  syncEventSources() // source 追加/削除/URL 変更を overlay イベントループへ反映
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
  const r = glassVisibility.compute(data.config, data.statuses)
  visible = r.map
  applyDisplay(displayRuntime.seed(data.config, r.truthMap)) // init は seed (listener 未配線・発火させない)
  pages = buildRuntimePages(data, visible)
  idx = 0

  // 起動ページ。先頭ページのコンテナ集合 (linear=全面 1 cell / grid=セル別) で作成し、
  // 以後の差分同期 (sync) の applied state として seed する。
  const { cells } = renderCurrentCells()
  lastOverlayKey = null
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: cells.length,
      textObject: cells.map((c) => new TextContainerProperty(c)),
    }),
  )
  sync.seed(cells)

  eventUnsub = bridge.onEvenHubEvent(onEvent)
  storeUnsub = subscribe(onStoreUpdate)
  if (typeof window !== 'undefined') {
    window.addEventListener('toolbar:config-changed', onConfigChangedEvent)
    window.addEventListener('toolbar:overlay', onOverlayEvent) // overlay トリガ (再利用可能)
    window.addEventListener('beforeunload', cleanup)
  }
  syncEventSources() // server source の overlay イベント long-poll を開始

  await initDeviceBattery(bridge) // HUD のグラスバッテリー (builtin に反映)
  await applyImuConfig() // config.imu.enabled なら IMU 起動 (onEvent 登録後・前提コンテナ作成後)
  scheduleGlassClock() // 時刻 HUD を毎分更新 (store.notify を介さない glass-local タイマー)
}
