// source 一覧/追加/編集/削除/接続テストの click ハンドラ。actions.ts の CLICK_ACTIONS に合流する。
// state/render-port/sync/conditions-ui/glass-edit と config・store に依存。
import {
  addServer,
  promoteSourceUrl,
  removeSource,
  removeSourceUrl,
  saveConfig,
  setSourceEnabled,
  sourceById,
  sourceUrls,
} from '../config'
import { setSourcesFromConfig } from '../store'
import { runConnectionTest } from './conditions-ui'
import { swipeState } from './glass-edit'
import { requestRender } from './render-port'
import { ctx } from './state'

type ClickHandler = (t: HTMLElement, e: MouseEvent) => void | Promise<void>

export const SOURCE_CLICK_ACTIONS: Record<string, ClickHandler> = {
  // ── sources-nav ──
  'manage-sources'() {
    ctx.view = 'sources'
    requestRender()
  },

  // ── source add-edit-url ──
  'open-add-source'() {
    ctx.view = 'add-source'
    requestRender()
  },
  'add-to-preset'(t) {
    // 既存 source をこの preset に追加する。
    const id = t.dataset.src
    if (id) {
      setSourceEnabled(ctx.config, id, true)
      void saveConfig(ctx.config)
      setSourcesFromConfig(ctx.config) // fetch 範囲を広げる (取得開始)
      ctx.view = 'home'
      requestRender()
    }
  },
  'remove-from-preset'(t) {
    // この preset から外す (非破壊)。実体は残り、glass/Source カードからは消える。
    // Home の swipe→🗑 から呼ばれる (source-detail の Remove ボタンは廃止)。
    const id = t.dataset.src
    if (id) {
      if (swipeState.openSrc === id) swipeState.openSrc = null // 消えるカードの swipe 状態を破棄
      setSourceEnabled(ctx.config, id, false)
      void saveConfig(ctx.config)
      setSourcesFromConfig(ctx.config) // fetch 範囲を狭める (停止/status 破棄)
      if (ctx.view === 'source-detail') ctx.view = 'home' // 外した source の detail に留まらない
      requestRender()
    }
  },
  'create-new-source'() {
    // preset への新規追加: 実体を作り active preset に入れて URL 入力へ。戻り先は Home。
    const def = addServer(ctx.config, 'New server')
    void saveConfig(ctx.config)
    ctx.editingSourceId = def.id
    ctx.testState = 'idle'
    ctx.testUrl = ''
    ctx.editMachine = null
    ctx.sourceEditBack = 'home'
    ctx.view = 'source-edit'
    requestRender()
  },
  'new-source'() {
    // Sources 一覧からの新規 (実体追加)。戻り先は Sources 一覧。
    const def = addServer(ctx.config, 'New server')
    void saveConfig(ctx.config)
    ctx.editingSourceId = def.id
    ctx.testState = 'idle'
    ctx.testUrl = ''
    ctx.editMachine = null
    ctx.sourceEditBack = 'sources'
    ctx.view = 'source-edit'
    requestRender()
  },
  'edit-source'(t) {
    ctx.editingSourceId = t.dataset.src ?? null
    ctx.testState = 'idle'
    ctx.testUrl = ''
    ctx.editMachine = null
    // Source Detail から開いたら detail へ戻す (動線維持)。それ以外は Sources 一覧へ。
    ctx.sourceEditBack = ctx.view === 'source-detail' ? 'source-detail' : 'sources'
    ctx.view = 'source-edit'
    requestRender()
  },
  back() {
    ctx.editingSourceId = null
    ctx.view = ctx.sourceEditBack
    requestRender()
  },
  'delete-source'() {
    if (ctx.editingSourceId) {
      removeSource(ctx.config, ctx.editingSourceId)
      void saveConfig(ctx.config)
      setSourcesFromConfig(ctx.config)
      ctx.editingSourceId = null
      ctx.view = ctx.sourceEditBack
      requestRender()
    }
  },
  'url-remove'(t) {
    const s = ctx.editingSourceId ? sourceById(ctx.config, ctx.editingSourceId) : undefined
    const u = s ? sourceUrls(s)[Number(t.dataset.urlidx)] : undefined
    if (s && u) {
      removeSourceUrl(s, u)
      ctx.testUrl = '' // 入力欄を新しい主経路に追従させる
      void saveConfig(ctx.config)
      setSourcesFromConfig(ctx.config)
      requestRender()
    }
  },
  'url-primary'(t) {
    const s = ctx.editingSourceId ? sourceById(ctx.config, ctx.editingSourceId) : undefined
    const u = s ? sourceUrls(s)[Number(t.dataset.urlidx)] : undefined
    if (s && u) {
      promoteSourceUrl(s, u)
      ctx.testUrl = '' // 入力欄を新しい主経路に追従させる
      void saveConfig(ctx.config)
      setSourcesFromConfig(ctx.config)
      requestRender()
    }
  },

  // ── 接続テスト / ヘルプ ──
  async test() {
    await runConnectionTest()
  },
  help() {
    window.open('/help.html', '_blank')
  },
}
