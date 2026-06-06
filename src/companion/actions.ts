// companion のクリックイベントハンドラ (巨大な onClick switch)。
// state / render-port / sync / rows / glass-edit / fs-editor / conditions-ui / views / debug-console と config・store に一方向依存。

import {
  activeProfile,
  activeView,
  addPlace,
  addProfile,
  addServer,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  customLabelKey,
  DEFAULT_PLACE_RADIUS_M,
  DEFAULT_PROFILE_ID,
  duplicateActiveProfile,
  generateGlassLayout,
  genLabelId,
  genPageId,
  promoteSourceUrl,
  removePlace,
  removeProfile,
  removeSource,
  removeSourceUrl,
  renamePlace,
  renameProfile,
  saveConfig,
  setPlaceRadius,
  setSourceEnabled,
  sourceById,
  sourceUrls,
} from '../config'
import { effectiveOwner, normalizeHeading } from '../display-identity'
import { setSourcesFromConfig } from '../store'
import { applyOptionChange, onSuggestAccept, runConnectionTest } from './conditions-ui'
import { clearDbgLogs, copyDbgLogs, toggleDbgOpen } from './debug-console'
import { openFsEditor } from './fs-editor'
import { closeSwipe, swipeState } from './glass-edit'
import { requestRender } from './render-port'
import { headingCollidesInSomeProfile, MAX_CONDS } from './rows'
import { ctx } from './state'
import {
  applyDisplayLabels,
  applyProfileChange,
  editingLayout,
  emptyGlassLayout,
  parseKey,
  statusGroup,
} from './sync'
import { afterPlacesChange, getCompanionPosition } from './views'

export async function onClick(e: MouseEvent): Promise<void> {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
  if (!t) {
    closeSwipe() // 何もないところをタップ = 開いている swipe を閉じる
    return
  }
  switch (t.dataset.action) {
    case 'home':
      ctx.view = 'home'
      requestRender()
      break
    case 'open-source-detail':
      // swipe 直後(時間窓)や、どれか開いている時のカードタップは「閉じるだけ」で遷移しない。
      if (Date.now() - swipeState.endedAt < 350 || swipeState.openSrc != null) {
        closeSwipe()
        break
      }
      ctx.detailSourceId = t.dataset.src ?? null
      ctx.view = 'source-detail'
      requestRender()
      break
    case 'suggest-accept':
      onSuggestAccept()
      break
    case 'suggest-dismiss':
      // このセッション中は同じ提案 (同 profile) を再表示しない。glass はそのまま (手動操作を妨げない)。
      if (ctx.currentSuggestion) ctx.dismissedSuggestions.add(ctx.currentSuggestion.profileId)
      ctx.currentSuggestion = null
      requestRender()
      break
    case 'profile-add':
      addProfile(ctx.config, `Preset ${ctx.config.profiles.length + 1}`)
      applyProfileChange()
      break
    case 'profile-duplicate':
      duplicateActiveProfile(ctx.config)
      applyProfileChange()
      break
    case 'profile-rename': {
      const cur = activeProfile(ctx.config)
      const name = window.prompt('Preset name', cur.name)
      if (name?.trim()) {
        renameProfile(ctx.config, cur.id, name)
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'profile-delete': {
      const cur = activeProfile(ctx.config)
      if (cur.id === DEFAULT_PROFILE_ID || ctx.config.profiles.length <= 1) break
      if (!window.confirm(`Delete preset "${cur.name}"?`)) break
      if (removeProfile(ctx.config, cur.id)) applyProfileChange()
      break
    }
    case 'manage-sources':
      ctx.view = 'sources'
      requestRender()
      break
    case 'manage-places':
      ctx.view = 'places'
      requestRender()
      break
    case 'add-current-place': {
      // 現在地を取得して名前を付けて保存する。位置許可が無ければ案内して中断。
      const name = window.prompt('Place name', 'Home')
      if (!name?.trim()) break
      try {
        const pos = await getCompanionPosition()
        addPlace(ctx.config, name.trim(), pos.lat, pos.lon)
        afterPlacesChange()
      } catch {
        window.alert('Could not get your location. Allow location access and try again.')
      }
      break
    }
    case 'rename-place': {
      const id = t.dataset.place
      const p = ctx.config.places?.find((x) => x.id === id)
      if (!id || !p) break
      const name = window.prompt('Place name', p.label)
      if (name?.trim() && renamePlace(ctx.config, id, name.trim())) afterPlacesChange()
      break
    }
    case 'radius-place': {
      // ジオフェンス半径(m)。inPlace 表示条件と here(現在地)判定の圏を決める(#43)。
      const id = t.dataset.place
      const p = ctx.config.places?.find((x) => x.id === id)
      if (!id || !p) break
      const cur = String(p.radiusM ?? DEFAULT_PLACE_RADIUS_M)
      const input = window.prompt('Geofence radius (meters)', cur)
      const m = input == null ? Number.NaN : Number(input)
      if (Number.isFinite(m) && setPlaceRadius(ctx.config, id, m)) afterPlacesChange()
      break
    }
    case 'delete-place': {
      const id = t.dataset.place
      if (!id) break
      const p = ctx.config.places?.find((x) => x.id === id)
      if (p && window.confirm(`Delete "${p.label}"?`) && removePlace(ctx.config, id))
        afterPlacesChange()
      break
    }
    case 'open-add-source':
      ctx.view = 'add-source'
      requestRender()
      break
    case 'add-to-preset': {
      // 既存 source をこの preset に追加する。
      const id = t.dataset.src
      if (id) {
        setSourceEnabled(ctx.config, id, true)
        void saveConfig(ctx.config)
        setSourcesFromConfig(ctx.config) // fetch 範囲を広げる (取得開始)
        ctx.view = 'home'
        requestRender()
      }
      break
    }
    case 'remove-from-preset': {
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
      break
    }
    case 'create-new-source': {
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
      break
    }
    case 'new-source': {
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
      break
    }
    case 'edit-source':
      ctx.editingSourceId = t.dataset.src ?? null
      ctx.testState = 'idle'
      ctx.testUrl = ''
      ctx.editMachine = null
      // Source Detail から開いたら detail へ戻す (動線維持)。それ以外は Sources 一覧へ。
      ctx.sourceEditBack = ctx.view === 'source-detail' ? 'source-detail' : 'sources'
      ctx.view = 'source-edit'
      requestRender()
      break
    case 'back':
      ctx.editingSourceId = null
      ctx.view = ctx.sourceEditBack
      requestRender()
      break
    case 'delete-source':
      if (ctx.editingSourceId) {
        removeSource(ctx.config, ctx.editingSourceId)
        void saveConfig(ctx.config)
        setSourcesFromConfig(ctx.config)
        ctx.editingSourceId = null
        ctx.view = ctx.sourceEditBack
        requestRender()
      }
      break
    case 'url-remove': {
      const s = ctx.editingSourceId ? sourceById(ctx.config, ctx.editingSourceId) : undefined
      const u = s ? sourceUrls(s)[Number(t.dataset.urlidx)] : undefined
      if (s && u) {
        removeSourceUrl(s, u)
        ctx.testUrl = '' // 入力欄を新しい主経路に追従させる
        void saveConfig(ctx.config)
        setSourcesFromConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'url-primary': {
      const s = ctx.editingSourceId ? sourceById(ctx.config, ctx.editingSourceId) : undefined
      const u = s ? sourceUrls(s)[Number(t.dataset.urlidx)] : undefined
      if (s && u) {
        promoteSourceUrl(s, u)
        ctx.testUrl = '' // 入力欄を新しい主経路に追従させる
        void saveConfig(ctx.config)
        setSourcesFromConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'expand': {
      const ref = parseKey(t.dataset.key ?? '')
      const vg = activeView(ctx.config).groups[ref.sourceId]?.[ref.groupId]
      if (vg) {
        vg.expanded = !vg.expanded
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'toggle-group': {
      const ref = parseKey(t.dataset.key ?? '')
      const vg = activeView(ctx.config).groups[ref.sourceId]?.[ref.groupId]
      if (vg) {
        vg.enabled = !vg.enabled
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'edit-owner': {
      // 表示モデル Phase2: 同系統データの出自(owner)をリネームする。source.displayOwner を更新し、
      // displayLabel(衝突焼込)を再計算して保存。owner は source 単位なので同 source の全 group に効く。
      const src = sourceById(ctx.config, t.dataset.src ?? '')
      if (src) {
        const next = window.prompt('Owner name (to tell same-type data apart)', effectiveOwner(src))
        if (next?.trim()) {
          src.displayOwner = next.trim()
          applyDisplayLabels()
          void saveConfig(ctx.config)
          requestRender()
        }
      }
      break
    }
    case 'toggle-grouplabel': {
      // glass で group 名を前置するか (default-label)。
      const ref = parseKey(t.dataset.key ?? '')
      const vg = activeView(ctx.config).groups[ref.sourceId]?.[ref.groupId]
      if (vg) {
        vg.showDefaultLabel = !(vg.showDefaultLabel ?? ref.groupId !== 'clock')
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'edit-groupname': {
      // group 名のリネーム (素材・全 preset 共有)。同 source 内で同名にすると glass で 1 unit に
      // マージ表示され、別名にすると解除される (display-identity の merge unit)。
      const ref = parseKey(t.dataset.key ?? '')
      const meta = ctx.config.groups[ref.sourceId]?.[ref.groupId]
      if (meta) {
        const g = statusGroup(ref.sourceId, ref.groupId)
        const isBuiltin = ref.sourceId === BUILTIN_SOURCE_ID
        const base = isBuiltin
          ? (BUILTIN_GROUP_LABELS[ref.groupId] ?? ref.groupId)
          : g?.label || sourceById(ctx.config, ref.sourceId)?.label || ref.groupId
        const next = window.prompt('Group name', meta.displayName ?? base)
        if (next !== null) {
          const v = next.trim()
          // 変更後の見出しがいずれかの preset で別 group とマージされるなら、暗黙に発動させず
          // confirm で意図を確認する (base へ戻した結果マージされるケースも同様)。
          // 判定は描画と同じ resolver: 変更後の effective 見出しを先に確定してから比較する
          // (スコープは headingCollidesInSomeProfile = 全 profile の groupOrder 共存)。
          const renamed = v !== '' && v !== base
          const nextHeading = renamed
            ? v
            : isBuiltin
              ? (BUILTIN_GROUP_LABELS[ref.groupId] ?? ref.groupId)
              : (meta.lastLabel ?? '')
          const mergesWith = headingCollidesInSomeProfile(
            ref.sourceId,
            ref.groupId,
            normalizeHeading(nextHeading),
          )
          if (
            mergesWith &&
            !window.confirm(
              `"${nextHeading}" is already used by "${mergesWith}" in this source. Groups with the same name are combined on glass. Continue?`,
            )
          ) {
            break
          }
          if (renamed) {
            meta.displayName = v // 手動命名 (glass の見出しと merge 判定を上書き)
          } else {
            delete meta.displayName // 空 or base と同じ → producer の label に戻す
          }
          void saveConfig(ctx.config)
          requestRender()
        }
      }
      break
    }
    case 'toggle-seg': {
      const ref = parseKey(t.dataset.key ?? '')
      const vg = activeView(ctx.config).groups[ref.sourceId]?.[ref.groupId]
      const segId = t.dataset.seg
      if (vg && segId) {
        vg.segments[segId] = !(vg.segments[segId] ?? true)
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'opt-set': {
      // toggle オプション (#36。button)。select / number は change 経路 (onOptionChange) で処理する。
      // data-val は「クリック後に設定する値」(現在 OFF=1 / 現在 ON=0)。
      if (t.dataset.kind === 'toggle') applyOptionChange(t.dataset, t.dataset.val === '1')
      break
    }
    case 'seg-vis-add': {
      // 表示条件は素材 (SegMeta.visibility。profile 非依存)。
      const ref = parseKey(t.dataset.key ?? '')
      const sm = ctx.config.groups[ref.sourceId]?.[ref.groupId]?.segments.find(
        (s) => s.id === t.dataset.seg,
      )
      if (sm) {
        const seg = statusGroup(ref.sourceId, ref.groupId)?.segments.find(
          (s) => s.id === t.dataset.seg,
        )
        const hasPct = typeof seg?.percent === 'number'
        const cond = sm.visibility ?? { combinator: 'and', conditions: [] }
        if (cond.conditions.length < MAX_CONDS) {
          cond.conditions.push(
            hasPct
              ? { kind: 'threshold', op: 'gte', value: 80 }
              : { kind: 'onChange', holdMs: 5000 },
          )
          sm.visibility = cond
          void saveConfig(ctx.config)
          requestRender()
        }
      }
      break
    }
    case 'seg-vis-remove': {
      const ref = parseKey(t.dataset.key ?? '')
      const sm = ctx.config.groups[ref.sourceId]?.[ref.groupId]?.segments.find(
        (s) => s.id === t.dataset.seg,
      )
      const idx = Number(t.dataset.idx)
      if (sm?.visibility && Number.isInteger(idx)) {
        sm.visibility.conditions.splice(idx, 1)
        if (sm.visibility.conditions.length === 0) sm.visibility = undefined
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'layout-edit-toggle':
      ctx.layoutEditing = !ctx.layoutEditing
      requestRender()
      break
    case 'layout-customize': {
      // auto → explicit: 現在の groupOrder から 1 ページ目を生成して編集モードへ。
      activeView(ctx.config).pages = [
        { id: genPageId(), name: 'Page 1', layout: generateGlassLayout(ctx.config) },
      ]
      ctx.pageEditingIdx = 0
      ctx.layoutEditing = true // 生成と同時に編集モードへ
      void saveConfig(ctx.config)
      requestRender()
      break
    }
    case 'layout-reset': {
      // explicit → auto: 全ページと legacy glassLayout を破棄して自動デッキへ戻す。
      const view = activeView(ctx.config)
      view.pages = undefined
      view.glassLayout = undefined
      ctx.pageEditingIdx = 0
      ctx.layoutEditing = false
      void saveConfig(ctx.config)
      requestRender()
      break
    }
    case 'fs-open': {
      // フルスクリーン WYSIWYG エディタ (実験的)。explicit デッキ未生成なら 1 ページ目を作って開く。
      const view = activeView(ctx.config)
      if (!view.pages?.length) {
        view.pages = [{ id: genPageId(), name: 'Page 1', layout: generateGlassLayout(ctx.config) }]
        ctx.pageEditingIdx = 0
        void saveConfig(ctx.config)
      }
      openFsEditor()
      break
    }
    case 'layout-item-remove': {
      // segment を全行から外す → 未配置 (Unplaced 棚) に導出される。
      const key = t.dataset.segkey
      const lay = editingLayout()
      if (lay && key) {
        lay.rows = lay.rows.map((r) => r.filter((k) => k !== key))
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'label-add': {
      // 任意テキストのラベルを作成 (未配置棚に出る)。inline input から読む。
      const input = ctx.root?.querySelector<HTMLInputElement>('.lay-add-input')
      const text = (input?.value ?? '').trim().slice(0, 64)
      const lay = editingLayout()
      if (lay && text) {
        lay.customLabels[genLabelId()] = { text }
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'label-delete': {
      // custom ラベルを完全削除 (customLabels から除去 + 全 rows の参照を除去)。
      const id = t.dataset.labelId
      const lay = editingLayout()
      if (lay && id) {
        delete lay.customLabels[id]
        const k = customLabelKey(id)
        lay.rows = lay.rows.map((r) => r.filter((x) => x !== k))
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'page-select': {
      const i = Number(t.dataset.pageIdx)
      const pages = activeView(ctx.config).pages
      if (pages && Number.isInteger(i) && i >= 0 && i < pages.length) {
        ctx.pageEditingIdx = i
        requestRender()
      }
      break
    }
    case 'page-add': {
      const view = activeView(ctx.config)
      view.pages ??= []
      view.pages.push({
        id: genPageId(),
        name: `Page ${view.pages.length + 1}`,
        layout: emptyGlassLayout(),
      })
      ctx.pageEditingIdx = view.pages.length - 1
      ctx.layoutEditing = true
      void saveConfig(ctx.config)
      requestRender()
      break
    }
    case 'page-remove': {
      const pages = activeView(ctx.config).pages
      if (pages && pages.length > 1 && ctx.pageEditingIdx < pages.length) {
        pages.splice(ctx.pageEditingIdx, 1)
        if (ctx.pageEditingIdx >= pages.length) ctx.pageEditingIdx = pages.length - 1
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'page-move-up': {
      const pages = activeView(ctx.config).pages
      const i = ctx.pageEditingIdx
      const a = pages?.[i - 1]
      const b = pages?.[i]
      if (pages && a && b && i > 0) {
        pages[i - 1] = b
        pages[i] = a
        ctx.pageEditingIdx = i - 1
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'page-move-down': {
      const pages = activeView(ctx.config).pages
      const i = ctx.pageEditingIdx
      const a = pages?.[i]
      const b = pages?.[i + 1]
      if (pages && a && b && i < pages.length - 1) {
        pages[i] = b
        pages[i + 1] = a
        ctx.pageEditingIdx = i + 1
        void saveConfig(ctx.config)
        requestRender()
      }
      break
    }
    case 'test':
      await runConnectionTest()
      break
    case 'help':
      window.open('/help.html', '_blank')
      break
    case 'console-toggle':
      toggleDbgOpen()
      requestRender()
      break
    case 'console-copy':
      await copyDbgLogs(t)
      break
    case 'console-clear':
      clearDbgLogs()
      break
    default:
      break
  }
}
