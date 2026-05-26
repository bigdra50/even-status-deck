import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { emptyConfig, loadConfig } from './config'
import { fetchClaudeLimits, fetchCodexLimits, fetchMachine, fetchUsage } from './data'
import { buildViews, type GlassData, type GView, renderGlass } from './glass-render'

// glass (G2 576×288) の描画。companion と同じ WebView 内で動くが bridge 経由で
// glass にだけ描く。純粋ロジックは glass-render.ts、ここは状態と bridge 配線。
const DISPLAY_W = 576
const DISPLAY_H = 288
const CONTAINER_ID = 1
const CONTAINER_NAME = 'toolbar'

let gbridge: EvenAppBridge | null = null
const data: GlassData = {
  config: emptyConfig(),
  machine: null,
  claude: null,
  codex: null,
  usage: null,
}
let views: GView[] = ['summary']
let idx = 0
let lastClickAt = 0

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

// single click → summary、double click → 終了、swipe → ビュー巡回。
// click は sysEvent、swipe(scroll) は textEvent で届く (handle-input 修正済み設計)。
function onEvent(event: EvenHubEvent): void {
  const sys = event.sysEvent
  if (sys) {
    const now = Date.now()
    if (now - lastClickAt < 200) return // 連続発火の握りつぶし
    lastClickAt = now
    if (sys.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
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

async function poll(): Promise<void> {
  // claude / usage は速いので先に描画し、codex (app-server 起動が遅い) は取れ次第更新。
  const [c, u] = await Promise.all([fetchClaudeLimits(), fetchUsage()])
  data.claude = c
  data.usage = u
  refresh()
  data.codex = await fetchCodexLimits()
  refresh()
}

// companion で設定変更 (saveConfig) されたら即再描画する。
async function onConfigChanged(): Promise<void> {
  data.config = await loadConfig()
  views = buildViews(data)
  if (idx >= views.length) idx = 0
  refresh()
}

export async function initGlass(bridge: EvenAppBridge): Promise<void> {
  gbridge = bridge
  const [m, cfg] = await Promise.all([fetchMachine(), loadConfig()])
  data.machine = m
  data.config = cfg
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
  if (typeof window !== 'undefined') {
    window.addEventListener('toolbar:config-changed', () => void onConfigChanged())
  }

  await poll()
  setInterval(() => void poll(), 60_000)
}
