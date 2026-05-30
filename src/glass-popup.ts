// 通知ポップアップ (再利用可能モジュール)。グラスの現在表示の「上下 1 行」を残し、中央に角丸の
// 通知カードを重ねた overlay を作る。複数通知はスタックし、左ドットで件数と現在位置を示す。
//
// 使い方 (glass 側):
//   - pushPopup(notif) で通知を積む (外部トリガ: window 'toolbar:popup' イベント等)。
//   - isPopupActive() の間は popupOverlayContainers(top, bottom) を rebuild で描く。
//   - スクロールで scrollPopup(±1)、タップで dismissCurrentPopup()。
//   - popupTopoKey() が変わったら rebuild する (件数/選択が変わった合図)。
//
// SDK 制約により text の輝度/アニメは無いので、表示/消去は rebuild の即時切替 (フェード等は不可)。
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { compileGrid, type GridLayout } from './glass-layout'

export type PopupNotif = { app: string; sender: string; body: string }

const MAX = 4 // スタック最大数 (ドット px 列が box 内に収まる範囲)
const DOT_CX = 40 // ドット中心の x (通知 box 左辺 x48 のすぐ左)

let stack: PopupNotif[] = []
let cursor = 0

export function pushPopup(n: PopupNotif): void {
  if (stack.length < MAX) stack.push(n)
}
export function dismissCurrentPopup(): void {
  if (!stack.length) return
  stack.splice(cursor, 1)
  if (cursor >= stack.length) cursor = Math.max(0, stack.length - 1)
}
export function scrollPopup(dir: number): void {
  if (!stack.length) return
  cursor = Math.max(0, Math.min(cursor + dir, stack.length - 1))
}
export function clearPopups(): void {
  stack = []
  cursor = 0
}
export function isPopupActive(): boolean {
  return stack.length > 0
}
// 件数 + 現在位置。変わると glass が rebuild する keying に使う。
export function popupTopoKey(): string {
  return `${stack.length}:${cursor}`
}

// 現在表示の上下 1 行 (topLine / bottomLine) を残し、中央に通知カードを重ねた overlay コンテナ列。
// グリッド (上行 + 中央カード + 下行) + px 中心揃えのスタックドット。
export function popupOverlayContainers(
  topLine: string,
  bottomLine: string,
): TextContainerProperty[] {
  const cur = Math.max(0, Math.min(cursor, stack.length - 1))
  const n = stack[cur]
  // 1 行目 = タイトル、2 行目以降 (sender + body) は 2 字下げ。
  const box = n
    ? [`${n.app} · Now`, ...`${n.sender}\n${n.body}`.split('\n').map((l) => `  ${l}`)].join('\n')
    : ''
  const layout: GridLayout = {
    cells: [
      { id: 'top', col: 0, row: 0, colSpan: 12, rowSpan: 1, content: topLine },
      {
        id: 'box',
        col: 1,
        row: 2,
        colSpan: 10,
        rowSpan: 6,
        content: box,
        border: 2,
        radius: 8,
        padding: 6,
      },
      { id: 'bottom', col: 0, row: 9, colSpan: 12, rowSpan: 1, content: bottomLine },
    ],
  }
  const grid = compileGrid(layout).map((c) => new TextContainerProperty(c))
  // スタックドット: 各ドットを px 位置の個別コンテナにして中心 (x=DOT_CX) を揃える
  // (text 列の space では narrow な · の中心が • とずれるため)。box 内で縦中央寄せ。
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
