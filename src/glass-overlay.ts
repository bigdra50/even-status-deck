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

export type Notif = { app: string; sender: string; body: string }
export type ToastOpts = { durationMs?: number; action?: string; onAction?: () => void }
export type DialogOpts = { onResult?: (index: number) => void }

type Toast = ToastOpts & { text: string; durationMs: number; expiresAt: number | null }
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

// 上行 + 中央ボックス + 下行 の grid を compile (event 層は compileGrid が注入)。
function framedBox(top: string, bottom: string, boxContent: string): TextContainerProperty[] {
  const layout: GridLayout = {
    cells: [
      { id: 'top', col: 0, row: 0, colSpan: 12, rowSpan: 1, content: top },
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
      { id: 'bottom', col: 0, row: 9, colSpan: 12, rowSpan: 1, content: bottom },
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

// toast: 下地ビュー (上 8 行のみ=下端は空ける) + 下端の枠付き 1 行。action 付きは末尾に [action]。
function toastContainers(baseLines: string[], t: Toast): TextContainerProperty[] {
  const base = fullContainer(baseLines.slice(0, 8).join('\n'))
  const text = t.action ? `${t.text}   [${t.action}]` : t.text
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
    content: text,
    isEventCapture: 0,
  })
  return [base, row]
}

export function createOverlayManager() {
  let notifStack: Notif[] = []
  let notifIdx = 0
  let toasts: Toast[] = []
  let dialog: Dialog | null = null
  let banner: string | null = null

  // 優先度 dialog > notification > toast で 1 つを active に。banner は別 (上行合成)。
  function activeKind(): 'dialog' | 'notification' | 'toast' | null {
    if (dialog) return 'dialog'
    if (notifStack.length) return 'notification'
    if (toasts.length) return 'toast'
    return null
  }

  return {
    notify(n: Notif): void {
      if (notifStack.length < NOTIF_MAX) notifStack.push(n)
    },
    toast(text: string, opts: ToastOpts = {}): void {
      toasts.push({
        text,
        durationMs: opts.durationMs ?? DEFAULT_TOAST_MS,
        action: opts.action,
        onAction: opts.onAction,
        expiresAt: null,
      })
    },
    dialog(title: string, message: string, actions: string[], opts: DialogOpts = {}): void {
      dialog = {
        title,
        message,
        actions: actions.length ? actions : ['OK'],
        sel: 0,
        onResult: opts.onResult,
      }
    },
    setBanner(text: string): void {
      banner = text
    },
    clearBanner(): void {
      banner = null
    },
    clear(): void {
      notifStack = []
      notifIdx = 0
      toasts = []
      dialog = null
      banner = null
    },

    isActive(): boolean {
      return activeKind() !== null || banner !== null
    },

    // 描画キー。種類 + 内容 + 選択/cursor + banner で構成。変わると glass が rebuild する。
    key(): string {
      const b = banner ? `|b:${banner.length}` : ''
      const k = activeKind()
      if (k === 'dialog' && dialog) return `dlg:${dialog.sel}/${dialog.actions.length}${b}`
      if (k === 'notification') return `ntf:${notifStack.length}:${notifIdx}${b}`
      if (k === 'toast' && toasts[0]) return `tst:${toasts.length}:${toasts[0].text.length}${b}`
      return `banner${b}`
    },

    // 次に tick が必要になる ms (toast の auto-dismiss 用)。無ければ Infinity。
    nextWakeMs(now: number): number {
      if (activeKind() !== 'toast') return Number.POSITIVE_INFINITY
      const head = toasts[0]
      if (!head) return Number.POSITIVE_INFINITY
      return head.expiresAt == null ? 0 : Math.max(0, head.expiresAt - now)
    },

    // toast の expiry を進める (表示開始で期限を設定し、満了でキューから外す)。
    tick(now: number): void {
      if (activeKind() !== 'toast') return
      const head = toasts[0]
      if (!head) return
      if (head.expiresAt == null) head.expiresAt = now + head.durationMs
      else if (head.expiresAt <= now) toasts.shift()
    },

    // overlay が scroll を消費したら true (false ならビュー巡回へ)。
    handleScroll(dir: number): boolean {
      const k = activeKind()
      if (k === 'dialog' && dialog) {
        dialog.sel = Math.max(0, Math.min(dialog.sel + dir, dialog.actions.length - 1))
        return true
      }
      if (k === 'notification') {
        notifIdx = Math.max(0, Math.min(notifIdx + dir, notifStack.length - 1))
        return true
      }
      return k === 'toast' // toast 中はスクロールを食う (ビュー巡回しない) が選択は無し
    },

    // overlay が tap を消費したら true。dialog=確定 / notification=既読→次 / toast=action or dismiss。
    handleTap(): boolean {
      const k = activeKind()
      if (k === 'dialog' && dialog) {
        const d = dialog
        dialog = null
        d.onResult?.(d.sel)
        return true
      }
      if (k === 'notification') {
        notifStack.splice(notifIdx, 1)
        if (notifIdx >= notifStack.length) notifIdx = Math.max(0, notifStack.length - 1)
        return true
      }
      if (k === 'toast' && toasts[0]) {
        toasts[0].onAction?.()
        toasts.shift()
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
      if (k === 'notification') return notificationContainers(top, bottom, notifStack, notifIdx)
      if (k === 'dialog' && dialog) return dialogContainers(lines[0] ?? '', bottom, dialog)
      if (k === 'toast' && toasts[0]) {
        const bl = showBanner ? [top, ...lines.slice(1)] : lines
        return toastContainers(bl, toasts[0])
      }
      // banner のみ。
      return [fullContainer([top, ...lines.slice(1)].join('\n'))]
    },
  }
}

export type OverlayManager = ReturnType<typeof createOverlayManager>
