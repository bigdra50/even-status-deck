// companion のクリックイベントハンドラ (巨大な onClick switch)。
// state / render-port / sync / rows / glass-edit / fs-editor / conditions-ui / views / debug-console と config・store に一方向依存。

import {
  activeProfile,
  activeView,
  addProfile,
  addServer,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  customLabelKey,
  DEFAULT_PROFILE_ID,
  duplicateActiveProfile,
  generateGlassLayout,
  genLabelId,
  genPageId,
  promoteSourceUrl,
  removeProfile,
  removeSource,
  removeSourceUrl,
  renameProfile,
  saveConfig,
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
import { canPlace, cellCapacity, findFreeRect, nextCellId } from './grid-edit'
import { requestRender } from './render-port'
import { headingCollidesInSomeProfile, MAX_CONDS } from './rows'
import { ctx } from './state'
import {
  applyDisplayLabels,
  applyProfileChange,
  editingLayout,
  editingPage,
  emptyGlassLayout,
  parseKey,
  statusGroup,
} from './sync'

type ClickHandler = (t: HTMLElement, e: MouseEvent) => void | Promise<void>

// 編集中ページの grid と選択セル (grid エディタの操作対象)。
function editingGridCell(): {
  grid: NonNullable<ReturnType<typeof editingPage>>['grid']
  cell:
    | NonNullable<NonNullable<ReturnType<typeof editingPage>>['grid']>['cells'][number]
    | undefined
} {
  const grid = editingPage()?.grid
  const cell = grid?.cells.find((c) => c.id === ctx.gridCellSel)
  return { grid, cell }
}

function confirmHeadingMerge(sourceId: string, groupId: string, nextHeading: string): boolean {
  const mergesWith = headingCollidesInSomeProfile(sourceId, groupId, normalizeHeading(nextHeading))
  if (
    mergesWith &&
    !window.confirm(
      `"${nextHeading}" is already used by "${mergesWith}" in this source. Groups with the same name are combined on glass. Continue?`,
    )
  ) {
    return false
  }
  return true
}

function commitGroupNameRename(
  ref: { sourceId: string; groupId: string },
  meta: { displayName?: string; lastLabel?: string },
  v: string,
  base: string,
  isBuiltin: boolean,
): void {
  const renamed = v !== '' && v !== base
  const nextHeading = renamed
    ? v
    : isBuiltin
      ? (BUILTIN_GROUP_LABELS[ref.groupId] ?? ref.groupId)
      : (meta.lastLabel ?? '')
  if (!confirmHeadingMerge(ref.sourceId, ref.groupId, nextHeading)) {
    return
  }
  if (renamed) {
    meta.displayName = v // 手動命名 (glass の見出しと merge 判定を上書き)
  } else {
    delete meta.displayName // 空 or base と同じ → producer の label に戻す
  }
  void saveConfig(ctx.config)
  requestRender()
}

export const CLICK_ACTIONS: Record<string, ClickHandler> = {
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

  // ── group view toggles ──
  expand(t) {
    const ref = parseKey(t.dataset.key ?? '')
    const vg = activeView(ctx.config).groups[ref.sourceId]?.[ref.groupId]
    if (vg) {
      vg.expanded = !vg.expanded
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'toggle-group'(t) {
    const ref = parseKey(t.dataset.key ?? '')
    const vg = activeView(ctx.config).groups[ref.sourceId]?.[ref.groupId]
    if (vg) {
      vg.enabled = !vg.enabled
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'edit-owner'(t) {
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
  },
  'toggle-grouplabel'(t) {
    // glass で group 名を前置するか (default-label)。
    const ref = parseKey(t.dataset.key ?? '')
    const vg = activeView(ctx.config).groups[ref.sourceId]?.[ref.groupId]
    if (vg) {
      vg.showDefaultLabel = !(vg.showDefaultLabel ?? ref.groupId !== 'clock')
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'edit-groupname'(t) {
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
        // 変更後の見出しがいずれかの preset で別 group とマージされるなら、暗黙に発動させず
        // confirm で意図を確認する (base へ戻した結果マージされるケースも同様)。
        // 判定は描画と同じ resolver: 変更後の effective 見出しを先に確定してから比較する
        // (スコープは headingCollidesInSomeProfile = 全 profile の groupOrder 共存)。
        commitGroupNameRename(ref, meta, next.trim(), base, isBuiltin)
      }
    }
  },
  'toggle-seg'(t) {
    const ref = parseKey(t.dataset.key ?? '')
    const vg = activeView(ctx.config).groups[ref.sourceId]?.[ref.groupId]
    const segId = t.dataset.seg
    if (vg && segId) {
      vg.segments[segId] = !(vg.segments[segId] ?? true)
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'opt-set'(t) {
    // toggle オプション (#36。button)。select / number は change 経路 (onOptionChange) で処理する。
    // data-val は「クリック後に設定する値」(現在 OFF=1 / 現在 ON=0)。
    if (t.dataset.kind === 'toggle') applyOptionChange(t.dataset, t.dataset.val === '1')
  },
  'seg-vis-add'(t) {
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
          hasPct ? { kind: 'threshold', op: 'gte', value: 80 } : { kind: 'onChange', holdMs: 5000 },
        )
        sm.visibility = cond
        void saveConfig(ctx.config)
        requestRender()
      }
    }
  },
  'seg-vis-remove'(t) {
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
  },

  // ── layout / page editing ──
  'layout-edit-toggle'() {
    ctx.layoutEditing = !ctx.layoutEditing
    requestRender()
  },
  'layout-customize'() {
    // auto → explicit: 現在の groupOrder から 1 ページ目を生成して編集モードへ。
    activeView(ctx.config).pages = [
      { id: genPageId(), name: 'Page 1', layout: generateGlassLayout(ctx.config) },
    ]
    ctx.pageEditingIdx = 0
    ctx.layoutEditing = true // 生成と同時に編集モードへ
    void saveConfig(ctx.config)
    requestRender()
  },
  'layout-reset'() {
    // explicit → auto: 全ページと legacy glassLayout を破棄して自動デッキへ戻す。
    const view = activeView(ctx.config)
    view.pages = undefined
    view.glassLayout = undefined
    ctx.pageEditingIdx = 0
    ctx.gridCellSel = null
    ctx.layoutEditing = false
    void saveConfig(ctx.config)
    requestRender()
  },
  'fs-open'() {
    // フルスクリーン WYSIWYG エディタ (実験的)。explicit デッキ未生成なら 1 ページ目を作って開く。
    const view = activeView(ctx.config)
    if (!view.pages?.length) {
      view.pages = [{ id: genPageId(), name: 'Page 1', layout: generateGlassLayout(ctx.config) }]
      ctx.pageEditingIdx = 0
      void saveConfig(ctx.config)
    }
    openFsEditor()
  },
  'layout-item-remove'(t) {
    // segment を全行から外す → 未配置 (Unplaced 棚) に導出される。grid ページではセル行から外す。
    const key = t.dataset.segkey
    if (!key) return
    const page = editingPage()
    if (page?.mode === 'grid' && page.grid) {
      for (const c of page.grid.cells) c.rows = c.rows.map((r) => r.filter((k) => k !== key))
    } else {
      const lay = editingLayout()
      if (!lay) return
      lay.rows = lay.rows.map((r) => r.filter((k) => k !== key))
    }
    void saveConfig(ctx.config)
    requestRender()
  },
  'label-add'() {
    // 任意テキストのラベルを作成 (未配置棚に出る)。inline input から読む。
    // grid ページでもラベル本文の置き場は page.layout.customLabels (共有ストア)。
    const input = ctx.root?.querySelector<HTMLInputElement>('.lay-add-input')
    const text = (input?.value ?? '').trim().slice(0, 64)
    const lay = editingLayout()
    if (lay && text) {
      lay.customLabels[genLabelId()] = { text }
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'label-delete'(t) {
    // custom ラベルを完全削除 (customLabels から除去 + 全 rows / grid セル行の参照を除去)。
    const id = t.dataset.labelId
    const lay = editingLayout()
    if (lay && id) {
      delete lay.customLabels[id]
      const k = customLabelKey(id)
      lay.rows = lay.rows.map((r) => r.filter((x) => x !== k))
      const grid = editingPage()?.grid
      if (grid) for (const c of grid.cells) c.rows = c.rows.map((r) => r.filter((x) => x !== k))
      void saveConfig(ctx.config)
      requestRender()
    }
  },

  // ── grid ページ編集 (Issue #17) ──
  'page-mode-toggle'() {
    const page = editingPage()
    if (!page) return
    if (page.mode === 'grid') {
      // grid → rows: mode を外すだけ (grid 定義は温存 = 再切替で配置が戻る。layout は凍結スナップショット)。
      page.mode = undefined
    } else {
      page.grid ??= { cells: [] }
      page.mode = 'grid'
    }
    ctx.gridCellSel = null
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-select'(t) {
    const id = t.dataset.cellId ?? null
    ctx.gridCellSel = ctx.gridCellSel === id ? null : id // 再タップで解除
    requestRender()
  },
  'grid-cell-add'() {
    const grid = editingPage()?.grid
    if (!grid || grid.cells.length >= 7) return
    const rect = findFreeRect(grid)
    if (!rect) return
    const id = nextCellId(grid)
    grid.cells.push({ id, ...rect, rows: [] })
    ctx.gridCellSel = id
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-remove'() {
    const grid = editingPage()?.grid
    if (!grid || !ctx.gridCellSel) return
    // セルごと削除 (中の chip は未配置棚に導出される)。
    grid.cells = grid.cells.filter((c) => c.id !== ctx.gridCellSel)
    ctx.gridCellSel = null
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-move'(t) {
    const { grid, cell } = editingGridCell()
    if (!grid || !cell) return
    const next = {
      ...cell,
      col: cell.col + Number(t.dataset.dx ?? 0),
      row: cell.row + Number(t.dataset.dy ?? 0),
    }
    if (!canPlace(grid, next, cell.id)) return
    cell.col = next.col
    cell.row = next.row
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-resize'(t) {
    const { grid, cell } = editingGridCell()
    if (!grid || !cell) return
    const delta = Number(t.dataset.delta ?? 0)
    const next = { ...cell }
    if (t.dataset.dim === 'w') next.colSpan += delta
    else next.rowSpan += delta
    if (!canPlace(grid, next, cell.id)) return
    cell.colSpan = next.colSpan
    cell.rowSpan = next.rowSpan
    // 縮んで容量を超えた行は棚に戻す (隠れた行に chip が残ると見えないまま温存される)。
    cell.rows = cell.rows.slice(0, cellCapacity(cell))
    // 1 行になったら枠線は無効 (normalize と同じ規則)。
    if (cell.rowSpan < 2) cell.border = undefined
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-border'() {
    const { cell } = editingGridCell()
    if (!cell || cell.rowSpan < 2) return
    cell.border = cell.border ? undefined : 1
    // 枠線で容量が減ることがある (padding 併用時)。超過行は棚に戻す (隠れ行の silent loss 防止)。
    cell.rows = cell.rows.slice(0, cellCapacity(cell))
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-chip-add'(t) {
    // 棚の chip をタップで選択中セルの空きがある最初の行へ追加する (drag の代替。e2e でも安定)。
    const key = t.dataset.segkey
    const { cell } = editingGridCell()
    if (!cell || !key) return
    // 空行があればそこへ、無ければ容量内で行を増やし、満杯なら最後の行へ相乗りする。
    const cap = cellCapacity(cell)
    const empty = cell.rows.findIndex((r) => r.length === 0)
    if (empty >= 0) cell.rows[empty]?.push(key)
    else if (cell.rows.length < cap) cell.rows.push([key])
    else cell.rows[cell.rows.length - 1]?.push(key)
    void saveConfig(ctx.config)
    requestRender()
  },
  'page-select'(t) {
    const i = Number(t.dataset.pageIdx)
    const pages = activeView(ctx.config).pages
    if (pages && Number.isInteger(i) && i >= 0 && i < pages.length) {
      ctx.pageEditingIdx = i
      // 別ページにも同名セル (cell1 等) があり得るため、選択は持ち越さない。
      ctx.gridCellSel = null
      requestRender()
    }
  },
  'page-add'() {
    const view = activeView(ctx.config)
    view.pages ??= []
    view.pages.push({
      id: genPageId(),
      name: `Page ${view.pages.length + 1}`,
      layout: emptyGlassLayout(),
    })
    ctx.pageEditingIdx = view.pages.length - 1
    ctx.gridCellSel = null
    ctx.layoutEditing = true
    void saveConfig(ctx.config)
    requestRender()
  },
  'page-remove'() {
    const pages = activeView(ctx.config).pages
    if (pages && pages.length > 1 && ctx.pageEditingIdx < pages.length) {
      pages.splice(ctx.pageEditingIdx, 1)
      if (ctx.pageEditingIdx >= pages.length) ctx.pageEditingIdx = pages.length - 1
      // index 詰めで別ページが繰り上がる。同名セル (cell1 等) の誤選択を防ぐ。
      ctx.gridCellSel = null
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'page-move-up'() {
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
  },
  'page-move-down'() {
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
  },

  // ── misc ──
  async test() {
    await runConnectionTest()
  },
  help() {
    window.open('/help.html', '_blank')
  },
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

export async function onClick(e: MouseEvent): Promise<void> {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
  if (!t) {
    closeSwipe() // 何もないところをタップ = 開いている swipe を閉じる
    return
  }
  await CLICK_ACTIONS[t.dataset.action ?? '']?.(t, e)
}
