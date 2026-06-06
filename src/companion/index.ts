import {
  activeProfile,
  activeView,
  addPlace,
  addProfile,
  addServer,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  customLabelId,
  customLabelKey,
  DEFAULT_PLACE_RADIUS_M,
  DEFAULT_PROFILE_ID,
  duplicateActiveProfile,
  ensureDefaultServer,
  type GroupRef,
  generateGlassLayout,
  genLabelId,
  genPageId,
  isCustomLabelKey,
  isRightDivider,
  isSourceEnabled,
  LOCATION_SOURCE_ID,
  loadConfig,
  type Profile,
  promoteSourceUrl,
  RIGHT_DIVIDER,
  reconcileSourceMachine,
  removePlace,
  removeProfile,
  removeSource,
  removeSourceUrl,
  renamePlace,
  renameProfile,
  type SourceDef,
  saveConfig,
  setActiveProfile,
  setPlaceRadius,
  setProfileGeofence,
  setSourceEnabled,
  sourceById,
  sourceUrl,
  sourceUrls,
} from '../config'
import { fetchMachineFrom } from '../data'
import { effectiveOwner, normalizeHeading } from '../display-identity'
import { esc } from '../escape'
import { MAX_ROWS, splitRowClusters } from '../glass-render'
import { icon } from '../icons'
import { setSegmentOption, setSourceOption } from '../options'
import { refreshSourceById, setSourcesFromConfig, startPolling, subscribe } from '../store'
import type { DisplayUi, VisibilityLeaf } from '../visibility'
import {
  clearDbgLogs,
  copyDbgLogs,
  hookConsole,
  onInput,
  renderDbgConsole,
  scrollDbgBottomIfOpen,
  toggleDbgOpen,
} from './debug-console'
import {
  applySwipeOpen,
  attachSortables,
  closeSwipe,
  onSwipeEnd,
  onSwipeMove,
  onSwipeStart,
  renderGlassSection,
  rowOverflow,
  swipeState,
} from './glass-edit'
import { registerPreviewUpdater, registerRenderer, requestRender } from './render-port'
import {
  allPlaceableKeys,
  headingCollidesInSomeProfile,
  MAX_CONDS,
  placeManageRow,
  renderSourceGroups,
  SOURCE_SECTIONS,
  segChoicesFor,
  segLabelParts,
  sourceAddRow,
  sourceDotNote,
  sourceManageRow,
  sourceNavRow,
  sourceSection,
} from './rows'
import { ctx } from './state'
import {
  applyDisplayLabels,
  applyProfileChange,
  editingLayout,
  emptyGlassLayout,
  glassPreviewHtml,
  maybeGeofenceAutoSwitch,
  parseKey,
  recomputeSuggestion,
  statusGroup,
  syncAll,
  visibleSig,
} from './sync'

// companion の共有可変状態は state.ts の ctx に集約した (分割モジュール間の共有点)。

// 表示項目リストの構成シグネチャ (順序込み)。変化したら項目リストを再描画する。
let lastVisibleSig = ''

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))
}

// ── Phase 4: プリセット切替の提案 (バナー) ──
// 提案バナー: 非モーダルで dismiss 可能 (Switch / × の 2 アクション)。glass は勝手に変えない。
// 提案が無ければ空文字 (Home から消える)。承認で Phase 2 の切替 (onSuggestAccept) を呼ぶ。
function renderSuggestionBanner(): string {
  const s = ctx.currentSuggestion
  if (!s) return ''
  const detail =
    s.reason === 'geofence'
      ? s.placeName
        ? `You're at ${esc(s.placeName)}.`
        : "You're at a saved place."
      : s.matchCount === 1
        ? 'A connected source matches this preset.'
        : `${s.matchCount} connected sources match this preset.`
  return `
    <div class="suggest-banner" role="status">
      <span class="suggest-icon">${icon('sparkles', { size: 16 })}</span>
      <div class="suggest-text">
        <div class="suggest-title">Switch to <strong>${esc(s.profileName)}</strong>?</div>
        <div class="suggest-sub">${detail}</div>
      </div>
      <button class="suggest-accept" data-action="suggest-accept">Switch</button>
      <button class="suggest-dismiss" data-action="suggest-dismiss" title="Dismiss" aria-label="Dismiss">${icon('x', { size: 16 })}</button>
    </div>`
}

// ── Profile (プリセット) ──
// Home 最上部の状況セット切替。select で active を切替え、隣のボタンで追加/複製/リネーム/削除。
// Default (id 'default') は削除不可なので、active が Default のときは削除ボタンを無効化する。
function renderProfileBar(): string {
  const active = activeProfile(ctx.config)
  const options = ctx.config.profiles
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${p.id === active.id ? 'selected' : ''}>${esc(p.name)}</option>`,
    )
    .join('')
  // Default は削除不可 + profile が 1 個だけのときも削除不可 (最後の 1 個は残す)。
  const canDelete = active.id !== DEFAULT_PROFILE_ID && ctx.config.profiles.length > 1
  const delAttr = canDelete ? '' : 'disabled'
  return `
    <div class="cmp-label">Preset</div>
    <div class="profile-bar">
      <select class="profile-select" data-action="profile-switch" aria-label="Preset">${options}</select>
      <button class="gear-btn" data-action="profile-rename" title="Rename preset" aria-label="Rename preset">${icon('pencil', { size: 16 })}</button>
      <button class="gear-btn" data-action="profile-duplicate" title="Duplicate preset" aria-label="Duplicate preset">${icon('copy', { size: 16 })}</button>
      <button class="gear-btn" data-action="profile-add" title="Add preset" aria-label="Add preset">${icon('plus', { size: 16 })}</button>
      <button class="gear-btn danger" data-action="profile-delete" title="Delete preset" aria-label="Delete preset" ${delAttr}>${icon('trash', { size: 16 })}</button>
    </div>
    ${renderProfileGeofence(active)}`
}

// #43 この preset をジオフェンス(保存地点)に連動させる UI。保存地点があるときだけ出す。
// place=Off で解除、suggest=バナー提案 / auto=圏内で自動切替。Location source(place group)の位置を使う。
function renderProfileGeofence(active: Profile): string {
  const places = ctx.config.places ?? []
  if (places.length === 0) return ''
  const gf = active.geofence
  const placeOpts =
    `<option value="" ${gf ? '' : 'selected'}>Off</option>` +
    places
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${gf?.placeId === p.id ? 'selected' : ''}>${esc(p.label)}</option>`,
      )
      .join('')
  return `<div class="profile-geofence">
    <span class="cmp-sub">When at</span>
    <select class="vis-select" data-action="profile-geofence-place" aria-label="Geofence place">${placeOpts}</select>
    <select class="vis-select" data-action="profile-geofence-mode" aria-label="Geofence mode" ${gf ? '' : 'disabled'}>
      <option value="suggest" ${gf?.mode === 'auto' ? '' : 'selected'}>Suggest</option>
      <option value="auto" ${gf?.mode === 'auto' ? 'selected' : ''}>Auto-switch</option>
    </select>
  </div>`
}

function renderHome(): string {
  // 新 IA: この preset で有効な全 source (builtin 含む) を nav カードで出す。tap で Source Detail へ。
  // 旧 flat Items リスト (全 source 横断の group リスト) は廃止。中身の設定は Source Detail に移設。
  const sources = ctx.config.sources.filter((s) => isSourceEnabled(ctx.config, s.id))
  // provenance でセクション化 (Included / Connected / Extensions)。空セクションは描かない。
  const sourcesHtml = sources.length
    ? SOURCE_SECTIONS.map(({ key, label, hint }) => {
        const inSec = sources.filter((s) => sourceSection(s) === key)
        if (!inSec.length) return ''
        return `<div class="src-section" title="${esc(hint)}">${label}</div>${inSec.map(sourceNavRow).join('')}`
      }).join('')
    : '<div class="cmp-sub">No sources in this preset.</div>'
  return `
    ${renderSuggestionBanner()}
    ${renderProfileBar()}

    <div class="cmp-label cmp-label-row">Sources (this preset)<span class="cmp-actions"><button class="link-btn" data-action="manage-sources">Manage all</button></span></div>
    <div class="cmp-sub">Tap a source to toggle its items &amp; settings.</div>
    ${sourcesHtml}
    <button class="save-btn sm" data-action="open-add-source">${icon('plus', { size: 14 })} Add source</button>

    <div class="cmp-label cmp-label-row">Places<span class="cmp-actions"><button class="link-btn" data-action="manage-places">Manage</button></span></div>
    <div class="cmp-sub">Saved places for geofencing: preset auto-switch and &ldquo;At place&rdquo; conditions.</div>

    ${renderGlassSection()}

    ${renderDbgConsole()}
  `
}

// 画面2 (新 IA): Source Detail。1 source の group/segment トグル・表示オプション・条件を集約。
// groupRow をそのまま再利用するので機能の取りこぼし無し。owner はヘッダで編集 (source 単位・全 preset 共有)。
function renderSourceDetail(): string {
  // 存在 かつ 現 preset で有効 な source のみ detail を出す。profile 自動切替(geofence)や
  // remove-from-preset/delete で無効/消滅したら Home へフォールバック (stale detail に居座らない)。
  const s =
    ctx.detailSourceId && isSourceEnabled(ctx.config, ctx.detailSourceId)
      ? sourceById(ctx.config, ctx.detailSourceId)
      : undefined
  if (!s) {
    ctx.view = 'home'
    return renderHome()
  }
  const isBuiltin = s.kind === 'builtin'
  const owner = effectiveOwner(s)
  const ownerEl = isBuiltin
    ? `<span class="owner-badge owner-fixed" title="Owner (code-owned)">${esc(owner)}</span>`
    : `<button class="owner-badge" data-action="edit-owner" data-src="${esc(s.id)}" title="Rename owner — distinguishes same-type data">${esc(owner)} ${icon('pencil', { size: 12 })}</button>`
  const { dotCls, note } = isBuiltin ? { dotCls: '', note: 'On-device' } : sourceDotNote(s)
  // 接続編集/削除(実体管理)は Sources(Manage all)、preset から外すのは Home の swipe→🗑 に集約。
  // Source Detail は「この preset での設定」に専念し、実体操作のボタンは置かない。
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">${icon('arrow-left', { size: 16 })} Sources</button>
      <span class="h-title">${esc(s.label)}</span><span></span></div>
    <div class="src-detail-head">
      <span class="conn-dot ${dotCls}"></span>${ownerEl}
      <span class="src-note" style="margin-left:auto">${esc(note)}</span>
    </div>
    <div class="cmp-sub">Toggles apply to <b>this preset</b>. Display options, show-when conditions and owner are <b>shared across all presets</b>.</div>
    <div id="detail-groups">${renderSourceGroups(s.id)}</div>
  `
}

// Sources 一覧: 全 source 実体 (preset 非依存)。編集・削除はここに集約。
function renderSources(): string {
  // Manage all は URL を持つ server source のみ (client=Location は Home の Add/Remove で管理)。
  const sources = ctx.config.sources.filter((s) => s.kind === 'server')
  const html = sources.length
    ? sources.map(sourceManageRow).join('')
    : '<div class="cmp-sub">No sources yet.</div>'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">${icon('arrow-left', { size: 16 })} Home</button>
      <span class="h-title">Sources</span><span></span></div>
    <div class="cmp-sub">Shared across all presets. Editing or deleting here affects every preset.</div>
    ${html}
    <button class="save-btn sm" data-action="new-source">${icon('plus', { size: 14 })} New source</button>
  `
}

// preset への source 追加 (既存プールから / 新規作成)。
function renderAddSource(): string {
  const available = ctx.config.sources.filter(
    (s) => s.kind !== 'builtin' && !isSourceEnabled(ctx.config, s.id),
  )
  const list = available.length
    ? available.map(sourceAddRow).join('')
    : '<div class="cmp-sub">All sources are already in this preset.</div>'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">${icon('arrow-left', { size: 16 })} Home</button>
      <span class="h-title">Add source</span><span></span></div>
    <div class="cmp-label">Existing sources</div>
    ${list}
    <div class="cmp-label">New</div>
    <button class="save-btn sm" data-action="create-new-source">${icon('plus', { size: 14 })} Create new source</button>
  `
}

function renderPlaces(): string {
  const places = ctx.config.places ?? []
  const html = places.length
    ? places.map(placeManageRow).join('')
    : '<div class="cmp-sub">No saved places yet. Save your current location to start.</div>'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">${icon('arrow-left', { size: 16 })} Home</button>
      <span class="h-title">Places</span><span></span></div>
    <div class="cmp-sub">Saved places drive geofencing — preset auto-switch/suggestions and &ldquo;At place&rdquo; visibility. Requires the Location source enabled.</div>
    ${html}
    <button class="save-btn sm" data-action="add-current-place">${icon('plus', { size: 14 })} Save current location</button>
  `
}

// companion(iPhone WebView)で現在地を 1 回取得する。地点保存用なので高精度を要求する。
function getCompanionPosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('geolocation unavailable'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(`geolocation error ${e.code}`)),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    )
  })
}

// 保存地点変更後の共通処理: 永続化 → store へ反映(setSavedPlaces 経由) → Location 再 poll → 再描画。
function afterPlacesChange(): void {
  void saveConfig(ctx.config)
  setSourcesFromConfig(ctx.config) // store の savedPlaces を最新化(geofence の圏内判定に即反映)
  refreshSourceById(LOCATION_SOURCE_ID) // Location が有効なら再 poll(refreshGeofencePosition で lastPos も更新)
  requestRender()
}

// ── ソース編集 ──
function renderDetected(): string {
  const m = ctx.editMachine
  if (!m) return ''
  return `<div class="field"><label>Machine name</label><div class="autoval">${esc(m.label)}</div></div>
     <div class="field"><label>machineId</label><div class="autoval mono">${esc(m.machineId)}</div></div>`
}

function renderTestStatus(): string {
  if (ctx.testState === 'testing')
    return `<div class="status-testing">${icon('loader', { size: 14, cls: 'ic-spin' })} Connecting…</div>`
  if (ctx.testState === 'ok')
    return `<div class="status-ok">${icon('check', { size: 14 })} Connected</div>${renderDetected()}`
  if (ctx.testState === 'error')
    return `<div class="status-err">${icon('x', { size: 14 })} Failed: ${esc(ctx.testError)}</div>
      <div class="cmp-sub">Check the URL and that the server is running.</div>`
  return '<div class="cmp-sub">Test the connection to load items.</div>'
}

function renderRouteList(s: SourceDef | undefined): string {
  const routes = s ? sourceUrls(s) : []
  if (routes.length === 0) return ''
  const rows = routes
    .map((u, i) => {
      const mark =
        i === 0
          ? '<span class="url-primary-mark">Primary</span>'
          : `<button class="link-btn" data-action="url-primary" data-urlidx="${i}">Make primary</button>`
      return `<div class="url-row">
        <span class="url-text mono">${esc(u)}</span>
        ${mark}
        <button class="url-del" data-action="url-remove" data-urlidx="${i}" title="Remove route" aria-label="Remove route">${icon('x', { size: 14 })}</button>
      </div>`
    })
    .join('')
  return `
    <div class="field"><label>Routes (failover order)</label>
      <div class="url-list">${rows}</div>
      <span class="help-link-static">First route is tried first, the rest are failover. Remove old IPs and keep a stable name (e.g. <span class="mono">name.local</span>) so you never edit the IP when moving networks.</span>
    </div>`
}

function renderSourceEdit(): string {
  const s = ctx.editingSourceId ? sourceById(ctx.config, ctx.editingSourceId) : undefined
  const url = ctx.testUrl || (s ? sourceUrl(s) : undefined) || 'http://127.0.0.1:8723'
  const testing = ctx.testState === 'testing'
  const backLabel =
    ctx.sourceEditBack === 'sources'
      ? 'Sources'
      : ctx.sourceEditBack === 'source-detail'
        ? 'Back'
        : 'Home'
  return `
    <div class="topbar"><button class="nav-btn" data-action="back">${icon('arrow-left', { size: 16 })} ${backLabel}</button>
      <span class="h-title">Server</span><span></span></div>
    <div class="field"><label>URL</label>
      <div class="field-row">
        <input type="text" value="${esc(url)}" placeholder="http://127.0.0.1:8723" />
        <button class="test-btn" data-action="test" ${testing ? 'disabled' : ''}>${testing ? '…' : 'Test'}</button>
      </div>
      <span class="help-link" data-action="help">Set up a local server ${icon('external-link', { size: 13 })}</span>
    </div>
    ${renderTestStatus()}
    ${renderRouteList(s)}
    <button class="danger-btn" data-action="delete-source">Delete source (all presets)</button>
  `
}

function render(): void {
  if (!ctx.root) return
  // Home を出す直前に提案を最新化する。store の health 変化は Home 以外 (source-edit) でも
  // 起こり得る (接続テストで追加した source が即 offline になる等) が、その間の notify は
  // onStoreUpdate が握り潰すため、Home へ戻った描画時に必ず計算し直してバナーを正す。
  if (ctx.view === 'home') recomputeSuggestion()
  ctx.root.innerHTML =
    ctx.view === 'source-edit'
      ? renderSourceEdit()
      : ctx.view === 'source-detail'
        ? renderSourceDetail()
        : ctx.view === 'sources'
          ? renderSources()
          : ctx.view === 'add-source'
            ? renderAddSource()
            : ctx.view === 'places'
              ? renderPlaces()
              : renderHome()
  // home と source-detail は群/段の構成シグネチャを記録し、SortableJS を張る。
  // source-detail は #source-list を持たない (group 横断並べ替え=Glass Layout の責務) ので
  // group sortable は張られず、.src-metrics の segment 並べ替えのみ有効になる。
  if (ctx.view === 'home' || ctx.view === 'source-detail') {
    lastVisibleSig = visibleSig()
    attachSortables()
    if (ctx.view === 'home') applySwipeOpen() // 再描画後に開いていた swipe カードの transform を復元
    if (ctx.view === 'home') scrollDbgBottomIfOpen() // 開いていれば最新行へ
  }
}

function updatePreview(): void {
  // 編集モードの WYSIWYG キャンバス (.wys-screen) は上書きしない (view の連結テキストのみ更新)。
  const el = ctx.root?.querySelector('.gpv-screen')
  if (el && !el.classList.contains('wys-screen')) el.innerHTML = glassPreviewHtml()
}

// ── イベント ──
async function onClick(e: MouseEvent): Promise<void> {
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

// segment 条件エディタ (combinator select / leaf の kind・op・value・hold) の変更を
// 素材 config.groups[*][*].segments[*].visibility に反映する。leaf は data-idx で特定する。
// change イベントの振り分け: 表示オプション (#36) → onOptionChange、それ以外 → onSegVisChange。
function onChange(e: Event): void {
  const action = (e.target as HTMLElement).dataset.action ?? ''
  if (action === 'profile-switch') onProfileSwitch(e)
  else if (action === 'opt-set') onOptionChange(e)
  else if (action === 'profile-geofence-place' || action === 'profile-geofence-mode')
    onGeofenceBindChange()
  else if (action === 'page-rename') onPageRename(e)
  else onSegVisChange(e)
}

// ページ名の変更 (rename input の change)。現在編集中ページ (pageEditingIdx) に作用する。
// requestRender() しない (input フォーカスを保つ。値は DOM が保持)。
function onPageRename(e: Event): void {
  const t = e.target as HTMLInputElement
  const raw = Number(t.dataset.pageIdx)
  const i = Number.isInteger(raw) ? raw : ctx.pageEditingIdx
  const page = activeView(ctx.config).pages?.[i]
  if (!page) return
  page.name = t.value.trim().slice(0, 24) || `Page ${i + 1}`
  void saveConfig(ctx.config)
}

// #43 active preset のジオフェンス連動(place + mode)を保存する。place/mode の両 select を読む。
function onGeofenceBindChange(): void {
  const active = activeProfile(ctx.config)
  const placeSel = ctx.root?.querySelector<HTMLSelectElement>(
    '[data-action="profile-geofence-place"]',
  )
  const modeSel = ctx.root?.querySelector<HTMLSelectElement>(
    '[data-action="profile-geofence-mode"]',
  )
  const placeId = placeSel?.value || null
  const mode = modeSel?.value === 'auto' ? 'auto' : 'suggest'
  if (setProfileGeofence(ctx.config, active.id, placeId, mode)) {
    ctx.lastGeofencePlace = null // バインド変更後は次の onStoreUpdate で auto 切替を再評価させる
    void saveConfig(ctx.config)
    requestRender()
  }
}

// Preset select の変更で active profile を切替える。enabledSourceIds が変わるため
// fetch 範囲も更新する (applyProfileChange)。
function onProfileSwitch(e: Event): void {
  const id = (e.target as HTMLSelectElement).value
  if (!id || id === ctx.config.activeProfileId) return
  setActiveProfile(ctx.config, id)
  applyProfileChange()
}

// 提案バナーの承認: Phase 2 の切替を呼ぶ (自動適用ではなくユーザー操作を起点にする)。
// 提案先が存在しなければ何もしない (取り違え防止)。切替後は applyProfileChange が提案を再計算する。
function onSuggestAccept(): void {
  const s = ctx.currentSuggestion
  if (!s || s.profileId === ctx.config.activeProfileId) return
  if (!ctx.config.profiles.some((p) => p.id === s.profileId)) return
  setActiveProfile(ctx.config, s.profileId)
  applyProfileChange()
}

// 表示オプション (#36) の select / number 変更を素材へ書き込む (clock は SegMeta.format に合成)。
// saveConfig が config-changed を dispatch → glass が loadConfig して実機描画にも反映。
function onOptionChange(e: Event): void {
  const t = e.target as HTMLSelectElement | HTMLInputElement
  applyOptionChange(t.dataset, t.value)
}

// 表示オプション 1 値の適用 (change 経路 = select/number、click 経路 = toggle で共通)。
// scope で segment/source を分け、kind による型変換と clamp は options.ts (setSegmentOption/setSourceOption)
// が行う。source 単位で再取得が要るオプションは当該 source を再 fetch する。
function applyOptionChange(ds: DOMStringMap, rawValue: unknown): void {
  const key = ds.key
  const scope = ds.scope
  const fieldId = ds.field
  if (!key || !fieldId || (scope !== 'segment' && scope !== 'source')) return
  const ref = parseKey(key)
  let ok = false
  if (scope === 'segment') {
    const segId = ds.seg
    if (!segId) return
    ok = setSegmentOption(ctx.config, ref.sourceId, ref.groupId, segId, fieldId, rawValue)
  } else {
    ok = setSourceOption(ctx.config, ref.sourceId, fieldId, rawValue)
    if (ok) {
      // 新しい options を store の defs へ反映してから再取得する。defs は config のクローンのため、
      // setSourcesFromConfig で同期しないと client producer が旧 options で fetch してしまう (#36 が
      // #40 へ先送りした「単位変更の即時反映」ギャップ)。urlset 不変なので他 source は再 fetch されない。
      setSourcesFromConfig(ctx.config)
      refreshSourceById(ref.sourceId)
    }
  }
  if (!ok) return
  void saveConfig(ctx.config)
  requestRender()
}

// kind 切替時の新 leaf 既定値。present は兄弟必須なので最初の兄弟を対象にする。
// threshold は host が percent を持たない場合、同 group の percent を持つ兄弟を既定対象にする
// (self だと percent 欠落で常に na になり機能しないため)。
function newLeafOfKind(kind: string, ref: GroupRef, hostId: string): VisibilityLeaf {
  if (kind === 'inPlace') return { kind: 'inPlace', placeId: ctx.config.places?.[0]?.id ?? '' }
  if (kind === 'present') {
    const sib = (ctx.config.groups[ref.sourceId]?.[ref.groupId]?.segments ?? [])
      .map((s) => s.id)
      .find((id) => id !== hostId)
    return { kind: 'present', seg: sib ?? '' }
  }
  if (kind === 'threshold') {
    const choices = segChoicesFor(ref)
    const leaf: VisibilityLeaf = { kind: 'threshold', op: 'gte', value: 80 }
    if (!choices.find((c) => c.id === hostId)?.hasPct) {
      const tgt = choices.find((c) => c.hasPct && c.id !== hostId)?.id
      if (tgt) leaf.seg = tgt
    }
    return leaf
  }
  return { kind: 'onChange', holdMs: 5000 }
}

function onSegVisChange(e: Event): void {
  const t = e.target as HTMLInputElement | HTMLSelectElement
  const action = t.dataset.action
  const key = t.dataset.key
  const segId = t.dataset.seg
  if (!action?.startsWith('seg-vis-') || !key || !segId) return
  const ref = parseKey(key)
  const sm = ctx.config.groups[ref.sourceId]?.[ref.groupId]?.segments.find((s) => s.id === segId)
  const vis = sm?.visibility
  if (!vis) return
  const val = t.value
  if (action === 'seg-vis-combinator') {
    vis.combinator = val === 'or' ? 'or' : 'and'
  } else if (action === 'seg-vis-display-ui') {
    // 提示先: Inline(空) = display 削除 / それ以外 = ui 設定 (text/durationMs は保持)。
    const uis: ReadonlySet<string> = new Set(['toast', 'notification'])
    if (uis.has(val)) vis.display = { ...vis.display, ui: val as DisplayUi }
    else delete vis.display
  } else if (action === 'seg-vis-display-text') {
    if (vis.display) {
      const text = val.trim().slice(0, 80)
      if (text) vis.display.text = text
      else delete vis.display.text
    }
  } else if (action === 'seg-vis-display-secs') {
    if (vis.display) vis.display.durationMs = clamp(Number(val), 1, 60) * 1000
  } else {
    const idx = Number(t.dataset.idx)
    const leaf = vis.conditions[idx]
    if (!leaf) return
    switch (action) {
      case 'seg-vis-leaf-kind':
        vis.conditions[idx] = newLeafOfKind(val, ref, segId)
        break
      case 'seg-vis-leaf-op':
        if (leaf.kind === 'threshold') leaf.op = val === 'lte' ? 'lte' : 'gte'
        break
      case 'seg-vis-leaf-value':
        if (leaf.kind === 'threshold') leaf.value = clamp(Number(val), 0, 100)
        break
      case 'seg-vis-leaf-hold':
        if (leaf.kind === 'onChange') leaf.holdMs = clamp(Number(val), 1, 60) * 1000
        break
      case 'seg-vis-leaf-seg':
        // 対象 segment を切替。self を選んだら省略形に戻す (後方互換・config churn 回避)。
        if (leaf.kind === 'present') leaf.seg = val
        else if (leaf.kind === 'threshold' || leaf.kind === 'onChange') {
          if (val === segId) delete leaf.seg
          else leaf.seg = val
        }
        break
      case 'seg-vis-leaf-absent':
        if (leaf.kind === 'present') leaf.absent = val === 'absent'
        break
      case 'seg-vis-leaf-place':
        if (leaf.kind === 'inPlace') leaf.placeId = val
        break
      case 'seg-vis-leaf-side':
        if (leaf.kind === 'inPlace') leaf.outside = val === 'outside'
        break
      default:
        return
    }
  }
  void saveConfig(ctx.config)
  requestRender()
}

// 編集中ソースの URL を検証・更新し、store に反映する。
async function runConnectionTest(): Promise<void> {
  const input = ctx.root?.querySelector<HTMLInputElement>('.field-row input[type="text"]')
  const url = (input?.value ?? '').trim()
  if (!url || !ctx.editingSourceId) return
  ctx.testUrl = url
  ctx.testState = 'testing'
  ctx.testError = ''
  requestRender()
  const clean = url.replace(/\/+$/, '')
  // fetchMachineFrom は machineId が非空 string のときだけ object を返す (parseMachineInfo)。
  // null は「接続失敗」または「接続成功だが machineId 不明」を意味し、後者でも空 machineId を
  // reconcile に渡さない (空 machineId による別マシン誤合流 = データ破壊を構造的に防ぐ)。
  const m = await fetchMachineFrom(clean)
  if (!m) {
    ctx.testState = 'error'
    ctx.testError = 'Connection failed'
    requestRender()
    return
  }
  ctx.editMachine = m
  const src = sourceById(ctx.config, ctx.editingSourceId)
  if (src) {
    // テストした経路を urls に足す (上書きしない = 既存経路を温存し複数経路を束ねる)。
    if (!src.urls.includes(clean)) src.urls.push(clean)
    src.url ??= clean // 後方互換の主 url は初回のみ設定
    src.label = m.label
    // machineId を反映して id を安定化する。同 machineId の既存 source への合流 / 旧 randomUUID の
    // id 付け替え / tombstone からの view 復元はすべて reconcileSourceMachine が担う。
    const settled = reconcileSourceMachine(ctx.config, ctx.editingSourceId, m.machineId, clean)
    if (settled) ctx.editingSourceId = settled.id // 合流/再 key で id が変わったら追従
  }
  await saveConfig(ctx.config)
  ctx.testState = 'ok'
  setSourcesFromConfig(ctx.config) // store に新 URL を反映 → 取得 → onStoreUpdate で再描画
  requestRender()
}

function onStoreUpdate(): void {
  syncAll() // 新 group を config に取り込み (永続。group の lastLabel = merge identity もここで捕捉)
  // 衝突解決 (segment owner prefix の displayLabel) を確定 (変化時のみ保存)。
  // group 見出しの衝突は永続リネームせず render-time マージ (display-identity の merge unit) で解く。
  if (applyDisplayLabels()) void saveConfig(ctx.config)
  maybeGeofenceAutoSwitch() // #43 現在地 place 変化で auto モードの preset へ自動切替(view 非依存=glass にも効く)
  // 構成 (status の有無で変わる) が変化したときだけ再描画。値だけの更新では再描画しない
  // (毎 poll の innerHTML churn が iOS WebContent jettison を招くため。issue #4)。
  if (ctx.view === 'home') {
    // 接続状態の変化で提案を再計算しバナーを更新する (dismiss 済みは recomputeSuggestion 内で除外)。
    const suggestionChanged = recomputeSuggestion()
    if (suggestionChanged || visibleSig() !== lastVisibleSig) requestRender()
  } else if (ctx.view === 'source-detail') {
    // 新 segment 出現等の構成変化で Source Detail を描き直す (新 IA)。
    if (visibleSig() !== lastVisibleSig) requestRender()
  }
}

// ── Fullscreen WYSIWYG レイアウトエディタ (実験的) ──
// iOS WKWebView は orientation lock / requestFullscreen が不安定なため、CSS で強制横
// (@media portrait で 90° 回転) する。回転コンテナ内では SortableJS の ghost 座標が壊れる
// ため、D&D は Pointer Events で自前実装する (elementFromPoint で行/ゾーンを判定)。
// 永続データは通常エディタと同じ glassLayout.rows + @right を共有する (新フォーマット無し)。
let fsRoot: HTMLElement | null = null
let fsDrag: { key: string; ghost: HTMLElement } | null = null
// 長押し arm 用の保留状態(arm 前)。codex 助言: arm 前はネイティブスクロール優先(tray を探せる)、
// しきい値超え移動で arm キャンセル、静止して timer 発火で初めて drag(ghost 生成 + preventDefault)へ。
let fsPending: {
  key: string
  chip: HTMLElement
  x: number
  y: number
  timer: ReturnType<typeof setTimeout>
} | null = null
const FS_LONGPRESS_MS = 220
const FS_MOVE_CANCEL_PX = 10
const FS_CUSTOM_SECTION = '__labels__' // 未配置 list で custom ラベルをまとめる擬似 source
const fsCollapsedSources = new Set<string>() // 折りたたみ中の source(editor open ごとに clear)

// チップの表示文字列 (実機の値。custom ラベルは本文)。
function fsChipText(key: string): string {
  if (isCustomLabelKey(key)) return editingLayout()?.customLabels[customLabelId(key)]?.text ?? ''
  const [sourceId, groupId, segId] = key.split('|')
  const sg = statusGroup(sourceId, groupId)?.segments.find((s) => s.id === segId)
  const { seg } = segLabelParts(key)
  return sg ? (sg.label ? `${sg.label} ${sg.value}` : sg.value) : seg
}

// glass 風チップ (緑/黒)。showGroup=true のときだけ group 名を薄く前置 (run dedup は呼び出し側)。
// rightSide=true は右クラスタ用に色を変える (左=緑 / 右=ティール) ことで配置側を識別可能にする。
function fsChip(key: string, showGroup: boolean, rightSide: boolean): string {
  const label = isCustomLabelKey(key)
  const { group } = segLabelParts(key)
  const grp = !label && showGroup && group ? `<span class="fs-grp">${esc(group)}</span>` : ''
  const cls = `fs-chip${label ? ' fs-chip-label' : rightSide ? ' fs-chip-r' : ''}`
  const x = `<button class="fs-x" data-action="fs-unplace" data-segkey="${esc(key)}" aria-label="Unplace">${icon('x', { size: 12 })}</button>`
  return `<span class="${cls}" data-segkey="${esc(key)}">${grp}<span class="fs-txt">${esc(fsChipText(key))}</span>${x}</span>`
}

// グループ前置の判定 (showDefaultLabel。未設定は clock=false / 他=true)。
function showsGroupLabel(key: string): boolean {
  const [sourceId, groupId] = key.split('|')
  return activeView(ctx.config).groups[sourceId]?.[groupId]?.showDefaultLabel ?? groupId !== 'clock'
}

// 1 クラスタ (左 or 右) を描画。実機グラスと同じ run dedup: 直前と同じ group の連続では
// group 名を 1 回だけ前置 (例「Mac CPU 46% / Mem 80%」)。custom ラベルは run を切る。
function renderFsCluster(keys: string[], rightSide: boolean): string {
  let prevGroup: string | null = null
  return keys
    .map((key) => {
      if (isCustomLabelKey(key)) {
        prevGroup = null
        return fsChip(key, false, rightSide)
      }
      const groupId = key.split('|')[1] ?? ''
      const showGroup = showsGroupLabel(key) && groupId !== prevGroup
      prevGroup = groupId
      return fsChip(key, showGroup, rightSide)
    })
    .join('')
}

// 未配置 list の 1 行(全幅)。左の grip(touch-action:none)からドラッグ、行本体はスクロール。
// × は不要(未配置)。grip 分離で iOS の「pan が drag を奪う(pointercancel)」を避ける。
function fsListItem(key: string): string {
  const { group } = segLabelParts(key)
  const grp = !isCustomLabelKey(key) && group ? `<span class="fs-grp">${esc(group)}</span>` : ''
  return `<span class="fs-chip fs-li" data-segkey="${esc(key)}"><span class="fs-li-grip">${icon('grip', { size: 14 })}</span>${grp}<span class="fs-txt">${esc(fsChipText(key))}</span></span>`
}

// プレビュー本体 (10 行 × 左/右ゾーン) + 右ペインの未配置 list(source 別折りたたみ) の HTML。
function renderFsBodyHtml(): string {
  const lay = editingLayout()
  if (!lay) return ''
  const rows: string[] = []
  for (let i = 0; i < MAX_ROWS; i++) {
    const { left, right } = splitRowClusters(lay.rows[i] ?? [])
    const over = rowOverflow(lay.rows[i] ?? [])
      ? `<span class="fs-over" title="May be too long for one line">${icon('alert', { size: 12 })}</span>`
      : ''
    rows.push(
      `<div class="fs-row"><div class="fs-zone" data-row="${i}" data-zone="left">${renderFsCluster(left, false)}</div>` +
        `<div class="fs-zone fs-zone-r" data-row="${i}" data-zone="right">${renderFsCluster(right, true)}${over}</div></div>`,
    )
  }
  const placed = new Set(lay.rows.flat().filter((k) => !isRightDivider(k)))
  const tray = allPlaceableKeys().filter((k) => !placed.has(k))
  // 未配置を source 別にグルーピング(出現順保持)。custom ラベルは末尾の擬似 source。
  const bySource = new Map<string, string[]>()
  for (const k of tray) {
    const sid = isCustomLabelKey(k) ? FS_CUSTOM_SECTION : (k.split('|')[0] ?? '?')
    const arr = bySource.get(sid)
    if (arr) arr.push(k)
    else bySource.set(sid, [k])
  }
  const sections = [...bySource.entries()]
    .map(([sid, keys]) => {
      const collapsed = fsCollapsedSources.has(sid)
      const label =
        sid === FS_CUSTOM_SECTION ? 'Labels' : (sourceById(ctx.config, sid)?.label ?? sid)
      const head =
        `<button class="fs-li-head" data-action="fs-toggle-source" data-src="${esc(sid)}">` +
        `${icon(collapsed ? 'chevron-right' : 'chevron-down', { size: 14 })}` +
        `<span class="fs-li-head-label">${esc(label)}</span><span class="fs-li-count">${keys.length}</span></button>`
      return head + (collapsed ? '' : keys.map(fsListItem).join(''))
    })
    .join('')
  const listBody = tray.length ? sections : '<span class="fs-empty">Nothing unplaced</span>'
  const listTitle = tray.length ? `Unplaced (${tray.length})` : 'Unplaced'
  // .fs-canvas が利用可能領域を埋め、.fs-glass がその中で 2:1 にコンテイン (container query)。
  // 右ペイン .fs-tray は未配置の source 別折りたたみ list(縦スクロール)。list へ drop で unplace。
  return `<div class="fs-canvas"><div class="fs-glass">${rows.join('')}</div></div>
    <div class="fs-tray" data-zone="tray"><div class="fs-list-title">${listTitle}</div>${listBody}</div>`
}

function renderFsShell(): string {
  return `<div class="fs-stage">
      <div class="fs-bar"><span class="fs-title">Glass layout — drag items onto the preview</span>
        <button class="fs-done" data-action="fs-done">Done</button></div>
      <div class="fs-body">${renderFsBodyHtml()}</div>
    </div>
    <div class="fs-hint">Rotate your phone to landscape ↻</div>`
}

function refreshFsBody(): void {
  const body = fsRoot?.querySelector('.fs-body')
  if (body) body.innerHTML = renderFsBodyHtml()
}

// 各行を split→join で正規化し、空になった右クラスタの @right を落とす。
function normalizeFsRows(): void {
  const lay = editingLayout()
  if (!lay) return
  lay.rows = lay.rows.map((r) => {
    const { left, right } = splitRowClusters(r)
    return right.length ? [...left, RIGHT_DIVIDER, ...right] : left
  })
}

function removeFsKey(key: string): void {
  const lay = editingLayout()
  if (lay) lay.rows = lay.rows.map((r) => r.filter((k) => k !== key))
}

function moveFsKeyToZone(key: string, rowIdx: number, side: 'left' | 'right'): void {
  const lay = editingLayout()
  if (!lay) return
  removeFsKey(key) // 重複配置を防ぐ (どこから来ても 1 箇所だけ)
  const { left, right } = splitRowClusters(lay.rows[rowIdx] ?? [])
  if (side === 'right') right.push(key)
  else left.push(key)
  lay.rows[rowIdx] = right.length ? [...left, RIGHT_DIVIDER, ...right] : left
  normalizeFsRows()
}

function fsZoneAt(e: PointerEvent): HTMLElement | null {
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  return el?.closest('.fs-zone, .fs-tray') ?? null
}

function fsClearHot(): void {
  for (const z of document.querySelectorAll('.fs-zone.fs-hot, .fs-tray.fs-hot')) {
    z.classList.remove('fs-hot')
  }
}

function fsPositionGhost(e: PointerEvent): void {
  if (!fsDrag) return
  fsDrag.ghost.style.left = `${e.clientX}px`
  fsDrag.ghost.style.top = `${e.clientY}px`
}

function onFsPointerDown(e: PointerEvent): void {
  if (fsDrag || fsPending) return
  const target = e.target as HTMLElement
  if (target.closest('.fs-x') || target.closest('.fs-done')) return // 削除/閉じるは click で処理
  const chip = target.closest('.fs-chip') as HTMLElement | null
  const key = chip?.dataset.segkey
  if (!chip || !key) return
  // 未配置 list の行: grip(touch-action:none)からのみ即ドラッグ。行本体(touch-action:pan)は
  // ネイティブスクロールに委ねる。iOS WKWebView で「pan 許可 + arm 後 preventDefault」が pointercancel
  // になり list→preview のドラッグが成立しない問題への対処(grip を none に分離)。
  if (chip.classList.contains('fs-li')) {
    if (!target.closest('.fs-li-grip')) return
    e.preventDefault()
    startFsDrag(chip, key, e.clientX, e.clientY)
    return
  }
  // preview chip(touch-action:none、スクロール先なし): 移動 or 長押しで arm。
  fsPending = {
    key,
    chip,
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(armFsDrag, FS_LONGPRESS_MS),
  }
  window.addEventListener('pointermove', onFsPendingMove)
  window.addEventListener('pointerup', clearFsPending)
  window.addEventListener('pointercancel', clearFsPending)
}

function clearFsPending(): void {
  if (!fsPending) return
  clearTimeout(fsPending.timer)
  fsPending = null
  window.removeEventListener('pointermove', onFsPendingMove)
  window.removeEventListener('pointerup', clearFsPending)
  window.removeEventListener('pointercancel', clearFsPending)
}

// preview chip のみ pending を使う。移動 = ドラッグ意図 → arm(scroll 先が無いので即)。
function onFsPendingMove(e: PointerEvent): void {
  if (!fsPending) return
  if (Math.hypot(e.clientX - fsPending.x, e.clientY - fsPending.y) > FS_MOVE_CANCEL_PX) armFsDrag()
}

// 長押し成立(preview chip): pending から drag へ。
function armFsDrag(): void {
  if (!fsPending) return
  const { key, chip, x, y } = fsPending
  clearFsPending()
  startFsDrag(chip, key, x, y)
}

// ドラッグ開始: ghost 生成 + drag リスナ登録(grip 即時 / preview arm の共通処理)。
function startFsDrag(chip: HTMLElement, key: string, x: number, y: number): void {
  const ghost = chip.cloneNode(true) as HTMLElement
  ghost.classList.add('fs-ghost')
  if (window.matchMedia('(orientation: portrait)').matches) ghost.classList.add('fs-ghost-rot')
  ghost.style.left = `${x}px`
  ghost.style.top = `${y}px`
  document.body.appendChild(ghost)
  fsDrag = { key, ghost }
  chip.classList.add('fs-chip-armed') // 元 chip を薄く(移動中の出所表示)。refreshFsBody で復帰。
  window.addEventListener('pointermove', onFsPointerMove)
  window.addEventListener('pointerup', onFsPointerUp)
  window.addEventListener('pointercancel', onFsDragAbort)
}

// drag 中の中断(pointercancel)。配置は変えずに後始末する。
function onFsDragAbort(): void {
  window.removeEventListener('pointermove', onFsPointerMove)
  window.removeEventListener('pointerup', onFsPointerUp)
  window.removeEventListener('pointercancel', onFsDragAbort)
  fsDrag?.ghost.remove()
  fsDrag = null
  fsClearHot()
  refreshFsBody()
}

function onFsPointerMove(e: PointerEvent): void {
  if (!fsDrag) return
  e.preventDefault()
  fsPositionGhost(e)
  fsClearHot()
  fsZoneAt(e)?.classList.add('fs-hot')
}

// unplace 後、その key の source セクションを開く(折りたたみ中だと list 上で消えたように見えるため)。
function fsExpandSourceOf(key: string): void {
  fsCollapsedSources.delete(isCustomLabelKey(key) ? FS_CUSTOM_SECTION : (key.split('|')[0] ?? '?'))
}

function onFsPointerUp(e: PointerEvent): void {
  window.removeEventListener('pointermove', onFsPointerMove)
  window.removeEventListener('pointerup', onFsPointerUp)
  window.removeEventListener('pointercancel', onFsDragAbort)
  const drag = fsDrag
  fsDrag = null
  drag?.ghost.remove()
  fsClearHot()
  if (!drag || !editingLayout()) return
  const zone = fsZoneAt(e)
  if (!zone) return
  if (zone.classList.contains('fs-tray')) {
    removeFsKey(drag.key)
    fsExpandSourceOf(drag.key) // 折りたたみ中の source へ戻すと消えて見えるので開く
    normalizeFsRows()
  } else {
    const row = Number(zone.dataset.row)
    if (!Number.isInteger(row)) return
    moveFsKeyToZone(drag.key, row, zone.dataset.zone === 'right' ? 'right' : 'left')
  }
  void saveConfig(ctx.config)
  refreshFsBody()
}

function onFsClick(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
  if (!t) return
  if (t.dataset.action === 'fs-done') {
    closeFsEditor()
    return
  }
  if (t.dataset.action === 'fs-toggle-source') {
    const sid = t.dataset.src
    if (sid) {
      if (fsCollapsedSources.has(sid)) fsCollapsedSources.delete(sid)
      else fsCollapsedSources.add(sid)
      refreshFsBody()
    }
    return
  }
  if (t.dataset.action === 'fs-unplace') {
    const key = t.dataset.segkey
    if (key && editingLayout()) {
      removeFsKey(key)
      fsExpandSourceOf(key) // 折りたたみ中の source へ戻すと消えて見えるので開く
      normalizeFsRows()
      void saveConfig(ctx.config)
      refreshFsBody()
    }
  }
}

function openFsEditor(): void {
  if (fsRoot) return
  fsCollapsedSources.clear() // open ごとに全 source 展開で開始
  fsRoot = document.createElement('div')
  fsRoot.className = 'fs-root'
  fsRoot.innerHTML = renderFsShell()
  document.body.appendChild(fsRoot)
  document.body.style.overflow = 'hidden' // 背面(companion)スクロールをロック(tray pan が body へ漏れない保険)
  fsRoot.addEventListener('pointerdown', onFsPointerDown)
  fsRoot.addEventListener('click', onFsClick)
}

function closeFsEditor(): void {
  if (!fsRoot) return
  clearFsPending()
  fsRoot.removeEventListener('pointerdown', onFsPointerDown)
  fsRoot.removeEventListener('click', onFsClick)
  window.removeEventListener('pointermove', onFsPointerMove)
  window.removeEventListener('pointerup', onFsPointerUp)
  window.removeEventListener('pointercancel', onFsDragAbort)
  fsDrag?.ghost.remove()
  fsDrag = null
  fsRoot.remove()
  fsRoot = null
  document.body.style.overflow = '' // 背面スクロールロックを解除
  requestRender() // 通常画面のプレビューを最新化
}

export async function mountCompanion(el: HTMLElement): Promise<void> {
  // render port の実体登録は副作用 (イベント/購読) より前に置く (requestRender の空振り防止)。
  registerRenderer(render)
  registerPreviewUpdater(updatePreview)
  ctx.root = el
  hookConsole() // 早期の console も拾えるよう最初に仕込む
  el.addEventListener('click', (e) => void onClick(e))
  el.addEventListener('change', (e) => void onChange(e)) // segment 条件 / 表示オプションの select/number
  el.addEventListener('input', onInput) // デバッグコンソールのフィルタ
  // swipe-to-delete (Home source カード)。touchmove は passive:false で横スワイプ時のみ preventDefault する。
  el.addEventListener('touchstart', onSwipeStart, { passive: true })
  el.addEventListener('touchmove', onSwipeMove, { passive: false })
  el.addEventListener('touchend', onSwipeEnd, { passive: true })
  el.addEventListener('touchcancel', onSwipeEnd, { passive: true })
  subscribe(onStoreUpdate)

  ctx.config = await loadConfig()
  // OD-4: dev (ブラウザ / 同一オリジン) のみ自動登録。prod (.ehpk) は location.origin が
  // glasses 側ループバックを指し Mac に届かないため登録せず、help.html の手順で LAN IP を入力させる。
  if (import.meta.env.DEV && ensureDefaultServer(ctx.config, location.origin))
    await saveConfig(ctx.config)
  setSourcesFromConfig(ctx.config)
  startPolling()
  requestRender() // 時刻 (clock) は glass-local タイマーが所有。companion は周期再描画しない
}

// bridge 接続後: 永続 config を読み直して store に反映する。
export async function onCompanionBridgeReady(): Promise<void> {
  ctx.config = await loadConfig()
  // OD-4: 自動登録は dev のみ (prod は help.html の手順で LAN IP を入力させる)。
  if (import.meta.env.DEV && ensureDefaultServer(ctx.config, location.origin))
    await saveConfig(ctx.config)
  setSourcesFromConfig(ctx.config)
  requestRender()
}
