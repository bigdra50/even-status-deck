// プリセット (profile) / 提案バナー / Home・Source Detail 遷移の click ハンドラ。
// actions.ts の CLICK_ACTIONS に合流する。state/render-port/sync/glass-edit/conditions-ui と config に依存。
import {
  activeProfile,
  addProfile,
  DEFAULT_PROFILE_ID,
  duplicateActiveProfile,
  removeProfile,
  renameProfile,
  saveConfig,
} from '../config'
import { onSuggestAccept } from './conditions-ui'
import { closeSwipe, swipeState } from './glass-edit'
import { requestRender } from './render-port'
import { ctx } from './state'
import { applyProfileChange } from './sync'

type ClickHandler = (t: HTMLElement, e: MouseEvent) => void | Promise<void>

export const PROFILE_CLICK_ACTIONS: Record<string, ClickHandler> = {
  // ── home / source-detail / suggest ──
  home() {
    ctx.view = 'home'
    requestRender()
  },
  'open-source-detail'(t) {
    // swipe 直後(時間窓)や、どれか開いている時のカードタップは「閉じるだけ」で遷移しない。
    if (Date.now() - swipeState.endedAt < 350 || swipeState.openSrc != null) {
      closeSwipe()
      return
    }
    ctx.detailSourceId = t.dataset.src ?? null
    ctx.view = 'source-detail'
    requestRender()
  },
  'suggest-accept'() {
    onSuggestAccept()
  },
  'suggest-dismiss'() {
    // このセッション中は同じ提案 (同 profile) を再表示しない。glass はそのまま (手動操作を妨げない)。
    if (ctx.currentSuggestion) ctx.dismissedSuggestions.add(ctx.currentSuggestion.profileId)
    ctx.currentSuggestion = null
    requestRender()
  },

  // ── profile ──
  'profile-add'() {
    addProfile(ctx.config, `Preset ${ctx.config.profiles.length + 1}`)
    applyProfileChange()
  },
  'profile-duplicate'() {
    duplicateActiveProfile(ctx.config)
    applyProfileChange()
  },
  'profile-rename'() {
    const cur = activeProfile(ctx.config)
    const name = window.prompt('Preset name', cur.name)
    if (name?.trim()) {
      renameProfile(ctx.config, cur.id, name)
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'profile-delete'() {
    const cur = activeProfile(ctx.config)
    if (cur.id === DEFAULT_PROFILE_ID || ctx.config.profiles.length <= 1) return
    if (!window.confirm(`Delete preset "${cur.name}"?`)) return
    if (removeProfile(ctx.config, cur.id)) applyProfileChange()
  },
}
