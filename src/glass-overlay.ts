// グラスの overlay UI 群 (再利用可能)。SDK には真の z-layer/アニメ/輝度が無いので、overlay は
// 「現在ビューの上に rebuildPageContainer で別コンテナ集合を送る = 即時切替」で表現する。
//
// 揃えた種類 (gpt-5.5 と確定した設計):
//   - notification : 中央カード、複数はスタック (左ドット)、scroll で切替・tap で既読→次
//   - toast        : 下端 1 行、durationMs で自動消去 (auto-advance キュー)。action 付き = snackbar
//   - dialog(modal): 中央ボックス、blocking、scroll で選択・tap で確定 (onResult)
//   - banner       : 上 1 行に常駐合成 (overlay でなく status 行扱い。dialog 中は隠す)
// popover/tooltip は anchor/hover 前提でグラス非対応のため含めない。
//
// 状態は種類ごとに分離し、優先度 dialog > notification > toast で 1 つを active にする。
// タイマーは持たず純粋状態機械: glass.ts が nextWakeMs() を見て setTimeout し、満了で tick()+refresh。
//
// 使い方 (glass.ts):
//   const ov = createOverlayManager()
//   ov.notify({app,sender,body}) / ov.toast(text,{durationMs,action,onAction})
//   ov.dialog(title,message,actions,{onResult}) / ov.setBanner(text) / ov.clearBanner()
//   refresh 内: if (ov.isActive()) { ov.tick(now); rebuild(ov.containers(base)) } (key() が変われば)
//   入力: ov.handleScroll(dir)/ov.handleTap() が true なら overlay が消費 (false ならビュー操作へ)
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { compileGrid, type GridLayout } from './glass-layout'
import { GLASS_HEIGHT, GLASS_PADDING, GLASS_WIDTH } from './glass-render'
import { sanitizeGlyphs } from './glyphs'

export type Notif = { app: string; sender: string; body: string }
export type ToastOpts = { durationMs?: number }
export type NotifOpts = { durationMs?: number } // durationMs 指定で自動消去 (省略=手動既読、server 通知向け)
export type DialogOpts = { onResult?: (index: number) => void }

type Toast = ToastOpts & { text: string; durationMs: number; expiresAt: number | null }
// 内部保持の notif。durationMs があれば expiresAt を arm して自動消去する (条件発火の notification 向け)。
type StoredNotif = Notif & { durationMs?: number; expiresAt: number | null }
type Dialog = {
  title: string
  message: string
  actions: string[]
  sel: number
  onResult?: (i: number) => void
}

const NOTIF_MAX = 4 // ドット px 列が box 内に収まる範囲
const DOT_CX = 40 // ドット中心 x (box 左辺 x48 のすぐ左)
const DEFAULT_TOAST_MS = 3000
const TOAST_MAX = 4 // toast キュー上限 (条件発火の連続でも無限に溜めない)
const DIALOG_MAX = 4 // dialog キュー上限 (ack-only の条件 dialog が溜まり過ぎないように)

// 簡易 content hash (djb2)。key() を文字数でなく内容で作り、同長別内容 (banner の値更新等) でも再描画させる。
// glass.ts も overlay 表示中の下地 (base) 変化検出に使う。
export function hashStr(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h
}

// 全面 1 text container (現在ビュー / toast の下地)。isEventCapture=1 で入力を受ける。
function fullContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: GLASS_WIDTH,
    height: GLASS_HEIGHT,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: GLASS_PADDING,
    containerID: 1,
    containerName: 'toolbar',
    content,
    isEventCapture: 1,
  })
}

// 上2行 + 中央ボックス(6行) + 下2行 の grid を compile (event 層は compileGrid が注入)。
// box は rows 2-7 で不変。gap 行(旧 row1/row8)を context 行に振り替え、上下2行ずつ残す。
function framedBox(top: string, bottom: string, boxContent: string): TextContainerProperty[] {
  const layout: GridLayout = {
    cells: [
      { id: 'top', col: 0, row: 0, colSpan: 12, rowSpan: 2, content: top },
      {
        id: 'box',
        col: 1,
        row: 2,
        colSpan: 10,
        rowSpan: 6,
        content: boxContent,
        border: 2,
        radius: 8,
        padding: 6,
      },
      { id: 'bottom', col: 0, row: 8, colSpan: 12, rowSpan: 2, content: bottom },
    ],
  }
  return compileGrid(layout).map((c) => new TextContainerProperty(c))
}

// notification: framedBox + px 中心揃えのスタックドット。
function notificationContainers(
  top: string,
  bottom: string,
  stack: Notif[],
  idx: number,
): TextContainerProperty[] {
  const cur = Math.max(0, Math.min(idx, stack.length - 1))
  const n = stack[cur]
  const box = n
    ? [`${n.app} · Now`, ...`${n.sender}\n${n.body}`.split('\n').map((l) => `  ${l}`)].join('\n')
    : ''
  const grid = framedBox(top, bottom, box)
  const ROW_H = 28
  const startY = Math.round(58 + (172 - stack.length * ROW_H) / 2)
  const dots = stack.map((_, i) => {
    const g = i === cur ? '•' : '·'
    return new TextContainerProperty({
      xPosition: Math.round(DOT_CX - getTextWidth(g) / 2),
      yPosition: startY + i * ROW_H,
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

// dialog: framedBox に title / message / アクション行 (選択は ▶ で示す)。
function dialogContainers(top: string, bottom: string, d: Dialog): TextContainerProperty[] {
  const actions = d.actions.map((a, i) => (i === d.sel ? `▶${a}` : ` ${a} `)).join('  ')
  return framedBox(top, bottom, `${d.title}\n${d.message}\n\n${actions}`)
}

// toast: 下地ビュー (上 8 行のみ=下端は空ける) + 下端の枠付き 1 行。自動消去のみ (入力非消費)。
function toastContainers(baseLines: string[], t: Toast): TextContainerProperty[] {
  const base = fullContainer(baseLines.slice(0, 8).join('\n'))
  const row = new TextContainerProperty({
    xPosition: 16,
    yPosition: 224,
    width: 544,
    height: 56,
    borderWidth: 1,
    borderColor: 12,
    borderRadius: 6,
    paddingLength: 4,
    containerID: 2,
    containerName: 'toast',
    content: t.text,
    isEventCapture: 0,
  })
  return [base, row]
}

export function createOverlayManager() {
  let notifStack: StoredNotif[] = []
  let notifIdx = 0
  let toasts: Toast[] = []
  let dialogs: Dialog[] = [] // dialog キュー (新規発火が表示中を上書きしないよう FIFO)
  let banner: string | null = null

  // 優先度 dialog > notification > toast で 1 つを active に。banner は別 (上行合成)。
  function activeKind(): 'dialog' | 'notification' | 'toast' | null {
    if (dialogs.length) return 'dialog'
    if (notifStack.length) return 'notification'
    if (toasts.length) return 'toast'
    return null
  }

  return {
    // emit 由来テキストに絵文字が混じるため、状態へ入る本文を必ず 1 回 sanitize する
    // (グラスへ渡る前に tofu を除去・置換する。sanitizeGlyphs は冪等)。
    notify(n: Notif, nopts: NotifOpts = {}): void {
      if (notifStack.length >= NOTIF_MAX) return
      notifStack.push({
        app: sanitizeGlyphs(n.app),
        sender: sanitizeGlyphs(n.sender),
        body: sanitizeGlyphs(n.body),
        durationMs: nopts.durationMs, // 指定時のみ自動消去 (省略=手動既読)
        expiresAt: null,
      })
    },
    toast(text: string, topts: ToastOpts = {}): void {
      if (toasts.length >= TOAST_MAX) toasts.splice(1, 1) // 上限: 表示中の head を残し最古の pending を捨てる
      toasts.push({
        text: sanitizeGlyphs(text),
        durationMs: topts.durationMs ?? DEFAULT_TOAST_MS,
        expiresAt: null,
      })
    },
    dialog(title: string, message: string, actions: string[], dopts: DialogOpts = {}): void {
      if (dialogs.length >= DIALOG_MAX) dialogs.splice(1, 1) // 上限: 表示中の head を残し最古の pending を捨てる
      dialogs.push({
        title: sanitizeGlyphs(title),
        message: sanitizeGlyphs(message),
        actions: (actions.length ? actions : ['OK']).map(sanitizeGlyphs),
        sel: 0,
        onResult: dopts.onResult,
      })
    },
    setBanner(text: string): void {
      banner = sanitizeGlyphs(text)
    },
    clearBanner(): void {
      banner = null
    },
    clear(): void {
      notifStack = []
      notifIdx = 0
      toasts = []
      dialogs = []
      banner = null
    },

    isActive(): boolean {
      return activeKind() !== null || banner !== null
    },

    // 描画キー。種類 + 内容 hash + 選択/cursor + banner hash で構成。変わると glass が rebuild する。
    // 文字数でなく content hash を使う (同長別内容の banner/toast 値更新でも再描画させる)。
    key(): string {
      const b = banner ? `|b:${hashStr(banner)}` : ''
      const k = activeKind()
      const dlg = dialogs[0]
      if (k === 'dialog' && dlg) return `dlg:${dialogs.length}:${dlg.sel}/${dlg.actions.length}${b}`
      if (k === 'notification') return `ntf:${notifStack.length}:${notifIdx}${b}`
      if (k === 'toast' && toasts[0]) return `tst:${toasts.length}:${hashStr(toasts[0].text)}${b}`
      return `banner${b}`
    },

    // 次に tick が必要になる ms (toast / 自動消去 notification 用)。無ければ Infinity。
    nextWakeMs(now: number): number {
      const k = activeKind()
      if (k === 'toast') {
        const head = toasts[0]
        if (!head) return Number.POSITIVE_INFINITY
        return head.expiresAt == null ? 0 : Math.max(0, head.expiresAt - now)
      }
      if (k === 'notification') {
        let min = Number.POSITIVE_INFINITY
        for (const n of notifStack) {
          if (n.durationMs == null) continue // 手動 notif は期限なし
          const t = n.expiresAt == null ? 0 : Math.max(0, n.expiresAt - now)
          if (t < min) min = t
        }
        return min
      }
      return Number.POSITIVE_INFINITY
    },

    // toast / notification の expiry を進める (表示開始で期限を設定し、満了で除去)。
    tick(now: number): void {
      const k = activeKind()
      if (k === 'toast') {
        const head = toasts[0]
        if (!head) return
        if (head.expiresAt == null) head.expiresAt = now + head.durationMs
        else if (head.expiresAt <= now) toasts.shift()
        return
      }
      if (k === 'notification') {
        // durationMs を持つ notif のみ arm + 満了除去 (手動 notif は残す)。
        for (const n of notifStack) {
          if (n.durationMs != null && n.expiresAt == null) n.expiresAt = now + n.durationMs
        }
        // 選択中 notif を保持して filter 後も同じものを指す (前方が消えて別 notif にズレるのを防ぐ)。
        const focused = notifStack[notifIdx]
        notifStack = notifStack.filter((n) => n.expiresAt == null || n.expiresAt > now)
        const ni = focused ? notifStack.indexOf(focused) : -1
        notifIdx = ni >= 0 ? ni : Math.min(notifIdx, Math.max(0, notifStack.length - 1))
      }
    },

    // overlay が scroll を消費したら true (false ならビュー巡回へ)。
    handleScroll(dir: number): boolean {
      const k = activeKind()
      const dlg = dialogs[0]
      if (k === 'dialog' && dlg) {
        dlg.sel = Math.max(0, Math.min(dlg.sel + dir, dlg.actions.length - 1))
        return true
      }
      if (k === 'notification') {
        notifIdx = Math.max(0, Math.min(notifIdx + dir, notifStack.length - 1))
        return true
      }
      return false // toast / banner はスクロール非消費 (自動消去・ビュー操作を妨げない)
    },

    // overlay が tap を消費したら true。dialog=確定 / notification=既読→次 / toast=action or dismiss。
    handleTap(): boolean {
      const k = activeKind()
      if (k === 'dialog' && dialogs[0]) {
        const d = dialogs.shift()
        d?.onResult?.(d.sel)
        return true
      }
      if (k === 'notification') {
        notifStack.splice(notifIdx, 1)
        if (notifIdx >= notifStack.length) notifIdx = Math.max(0, notifStack.length - 1)
        return true
      }
      // toast は入力非消費 (自動消去のみ。誤タップで消えない)。
      if (banner !== null) {
        banner = null // banner は tap で消せる (server 由来)
        return true
      }
      return false
    },

    // 現在ビュー(baseContent)の上に active overlay を重ねたコンテナ列。
    containers(baseContent: string): TextContainerProperty[] {
      const lines = baseContent.split('\n')
      // banner は上 1 行を上書き (dialog 中は隠す)。
      const showBanner = banner !== null && activeKind() !== 'dialog'
      const top = showBanner ? (banner ?? '') : (lines[0] ?? '')
      const bottom = lines.length > 1 ? (lines[lines.length - 1] ?? '') : ''
      const k = activeKind()
      if (k === 'notification') {
        // context を上下2行ずつ残す (上=banner/先頭2行、下=末尾2行)。重複は bStart で回避。
        const top2 = [top, lines[1] ?? ''].join('\n')
        const bStart = Math.max(2, lines.length - 2)
        const bottom2 = lines.slice(bStart).join('\n')
        return notificationContainers(top2, bottom2, notifStack, notifIdx)
      }
      if (k === 'dialog' && dialogs[0]) return dialogContainers(lines[0] ?? '', bottom, dialogs[0])
      if (k === 'toast' && toasts[0]) {
        const bl = showBanner ? [top, ...lines.slice(1)] : lines
        return toastContainers(bl, toasts[0])
      }
      // banner のみ。
      return [fullContainer([top, ...lines.slice(1)].join('\n'))]
    },
  }
}
