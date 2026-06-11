// companion のクリックイベントハンドラ (CLICK_ACTIONS の合成点)。
// state / render-port / sync / rows / glass-edit / fs-editor / conditions-ui / views / debug-console と config・store に一方向依存。
// 個別ハンドラは domain ごとに actions-profile / actions-source / actions-groups / actions-layout に分割し、
// ここでは表 (CLICK_ACTIONS) を merge して onClick を提供する (公開 API・action 名は不変)。

import { groupClickActions } from './actions-groups'
import { LAYOUT_CLICK_ACTIONS } from './actions-layout'
import { PROFILE_CLICK_ACTIONS } from './actions-profile'
import { SOURCE_CLICK_ACTIONS } from './actions-source'
import { clearDbgLogs, copyDbgLogs, toggleDbgOpen } from './debug-console'
import { closeSwipe } from './glass-edit'
import { requestRender } from './render-port'
import { headingCollidesInSomeProfile } from './rows'

type ClickHandler = (t: HTMLElement, e: MouseEvent) => void | Promise<void>

const MISC_CLICK_ACTIONS: Record<string, ClickHandler> = {
  'console-toggle'() {
    toggleDbgOpen()
    requestRender()
  },
  async 'console-copy'(t) {
    await copyDbgLogs(t)
  },
  'console-clear'() {
    clearDbgLogs()
  },
}

export const CLICK_ACTIONS: Record<string, ClickHandler> = {
  ...PROFILE_CLICK_ACTIONS,
  ...SOURCE_CLICK_ACTIONS,
  ...groupClickActions(headingCollidesInSomeProfile),
  ...LAYOUT_CLICK_ACTIONS,
  ...MISC_CLICK_ACTIONS,
}

export async function onClick(e: MouseEvent): Promise<void> {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
  if (!t) {
    closeSwipe() // 何もないところをタップ = 開いている swipe を閉じる
    return
  }
  await CLICK_ACTIONS[t.dataset.action ?? '']?.(t, e)
}
