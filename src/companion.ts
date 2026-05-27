import Sortable from 'sortablejs'
import {
  addServer,
  type Config,
  emptyConfig,
  type GroupRef,
  loadConfig,
  removeSource,
  saveConfig,
  sourceById,
  syncSourceWithStatus,
} from './config'
import { fetchMachineFrom, type MachineInfo } from './data'
import { esc } from './escape'
import { type GlassData, summaryBody } from './glass-render'
import type { Group } from './status-types'
import {
  getAllStatuses,
  getSourceStatus,
  setSources,
  startClock,
  startPolling,
  subscribe,
} from './store'

// companion (スマホ WebView) の Home / Source 編集。複数ソースを横断して設定する。
let view: 'home' | 'source-edit' = 'home'
let editingSourceId: string | null = null
let editMachine: MachineInfo | null = null // 接続テストの検出結果
let config: Config = emptyConfig()
let root: HTMLElement | null = null

// 接続テスト状態
let testState: 'idle' | 'testing' | 'ok' | 'error' = 'idle'
let testError = ''
let testUrl = ''

function glassData(): GlassData {
  return { config, statuses: getAllStatuses() }
}

function statusGroup(sourceId: string, groupId: string): Group | undefined {
  return getSourceStatus(sourceId)?.groups.find((g) => g.id === groupId)
}

// 全ソースの status を config に取り込み、追加があれば保存する。追加があれば true。
function syncAll(): boolean {
  let changed = false
  for (const [sid, status] of Object.entries(getAllStatuses())) {
    if (status && syncSourceWithStatus(config, sid, status)) changed = true
  }
  if (changed) void saveConfig(config)
  return changed
}

// ── プレビュー ──
function glassPreviewHtml(): string {
  const lines = summaryBody(glassData())
  const body = lines.map((l) => `<span class="grow">${esc(l)}</span>`).join('')
  const hint = config.glassHints ? '<span class="grow ghint">swipe: detail  tap: back</span>' : ''
  return `<div class="glass-screen"><div>${body}</div>${hint}</div>`
}

// ── 表示項目 (groupOrder 横断) ──
// 実在する (status にある) group だけを groupOrder 順に並べる。
function visibleRefs(): GroupRef[] {
  return config.groupOrder.filter((r) => statusGroup(r.sourceId, r.groupId))
}

// 表示項目リストの構成シグネチャ (順序込み)。変化したら項目リストを再描画する。
let lastVisibleSig = ''
function visibleSig(): string {
  return visibleRefs()
    .map((r) => `${r.sourceId}:${r.groupId}`)
    .join('|')
}

function groupRow(ref: GroupRef): string {
  const g = statusGroup(ref.sourceId, ref.groupId)
  const gcfg = config.groups[ref.sourceId]?.[ref.groupId]
  if (!g || !gcfg) return ''
  const src = sourceById(config, ref.sourceId)
  const key = `${esc(ref.sourceId)}|${esc(ref.groupId)}`
  const title = g.label || src?.label || ref.groupId
  const caret = gcfg.expanded ? '▾' : '▸'
  const segById = new Map(g.segments.map((s) => [s.id, s]))
  const metrics = gcfg.expanded
    ? `<div class="src-metrics" data-key="${key}">${gcfg.segments
        .map((sc) => {
          const seg = segById.get(sc.id)
          if (!seg) return ''
          return `<div class="metric-row"><span class="mgrip">⋮⋮</span>
              <span class="mname">${esc(seg.label || seg.id)}</span>
              <span class="mval">${esc(seg.value)}</span>
              <button class="tg sm ${sc.enabled ? 'on' : ''}" data-action="toggle-seg" data-key="${key}" data-seg="${esc(sc.id)}"></button></div>`
        })
        .join('')}</div>`
    : ''
  const srcTag =
    src && src.id !== ref.sourceId
      ? ''
      : src
        ? `<span class="src-note">${esc(src.label)}</span>`
        : ''
  return `<div class="src" data-key="${key}"><div class="src-head"><span class="src-grip">⋮⋮</span>
    <span class="src-caret" data-action="expand" data-key="${key}">${caret}</span>
    <span class="src-name" data-action="expand" data-key="${key}">${esc(title)}</span>
    ${srcTag}
    <button class="tg ${gcfg.enabled ? 'on' : ''}" data-action="toggle-group" data-key="${key}"></button></div>${metrics}</div>`
}

function renderItems(): string {
  return visibleRefs()
    .map((r) => groupRow(r))
    .join('')
}

// ── ソース一覧 ──
function sourceRow(s: { id: string; kind: string; label: string; url?: string }): string {
  if (s.kind === 'builtin') {
    return `<div class="src"><div class="src-head"><span class="conn-dot"></span>
      <span class="src-name">${esc(s.label)}</span><span class="src-note">組み込み</span></div></div>`
  }
  const online = getSourceStatus(s.id) != null
  return `<div class="src"><div class="src-head"><span class="conn-dot ${online ? '' : 'off'}"></span>
    <span class="src-name">${esc(s.label)}</span>
    <span class="src-note">${esc(s.url ?? '未設定')}</span>
    <button class="gear-btn" data-action="edit-source" data-src="${esc(s.id)}" title="編集">⚙</button></div></div>`
}

function renderHome(): string {
  const sources = config.sources.map((s) => sourceRow(s)).join('')
  return `
    <div class="cmp-label">ソース</div>
    ${sources}
    <button class="save-btn" data-action="add-source">+ サーバーを追加</button>

    <div class="cmp-label">表示項目 (グリップ ⋮⋮ をドラッグで並べ替え)</div>
    <div id="source-list">${renderItems()}</div>
    <div class="src"><div class="src-head">
      <span class="src-name" style="font-size:var(--fs-md);font-weight:500;">glass の操作ヒントを表示</span>
      <button class="tg sm ${config.glassHints ? 'on' : ''}" data-action="toggle-hints"></button></div></div>

    <div class="cmp-label">Glass プレビュー</div>
    <div class="gpv"><div class="gpv-cap">G2 576×288</div>
      <div class="gpv-screen">${glassPreviewHtml()}</div></div>
  `
}

// ── ソース編集 ──
function renderDetected(): string {
  const m = editMachine
  if (!m) return ''
  return `<div class="field"><label>マシン名 (自動取得)</label><div class="autoval">${esc(m.label)}</div></div>
     <div class="field"><label>machineId (自動)</label><div class="autoval mono">${esc(m.machineId)}</div></div>`
}

function renderTestStatus(): string {
  if (testState === 'testing') return '<div class="status-testing">⋯ 接続中…</div>'
  if (testState === 'ok') return `<div class="status-ok">✓ 接続OK</div>${renderDetected()}`
  if (testState === 'error')
    return `<div class="status-err">✗ 接続失敗: ${esc(testError)}</div>
      <div class="cmp-sub">URL とサーバーの起動を確認してください。</div>`
  return '<div class="cmp-sub">接続テストすると、サーバーから項目を取得します。</div>'
}

function renderSourceEdit(): string {
  const s = editingSourceId ? sourceById(config, editingSourceId) : undefined
  const url = testUrl || s?.url || 'http://127.0.0.1:8723'
  const testing = testState === 'testing'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">← Home</button>
      <span class="h-title">サーバー設定</span><span></span></div>
    <div class="field"><label>接続先 URL</label>
      <div class="field-row">
        <input type="text" value="${esc(url)}" placeholder="http://127.0.0.1:8723" />
        <button class="test-btn" data-action="test" ${testing ? 'disabled' : ''}>${testing ? '…' : '接続テスト'}</button>
      </div>
      <span class="help-link" data-action="help">ローカルサーバーの設定方法 →</span>
    </div>
    ${renderTestStatus()}
    <button class="danger-btn" data-action="remove-source">このソースを削除</button>
  `
}

function render(): void {
  if (!root) return
  root.innerHTML = view === 'source-edit' ? renderSourceEdit() : renderHome()
  if (view === 'home') {
    lastVisibleSig = visibleSig()
    attachSortables()
  }
}

function updatePreview(): void {
  const el = root?.querySelector('.gpv-screen')
  if (el) el.innerHTML = glassPreviewHtml()
}

// ── ドラッグ並べ替え ──
let sortables: Sortable[] = []
function attachSortables(): void {
  for (const s of sortables) s.destroy()
  sortables = []
  const list = document.getElementById('source-list')
  if (list) {
    sortables.push(
      Sortable.create(list, {
        handle: '.src-grip',
        animation: 150,
        onEnd: (e) => onGroupReorder(e.oldIndex, e.newIndex),
      }),
    )
  }
  for (const el of document.querySelectorAll<HTMLElement>('.src-metrics')) {
    const key = el.dataset.key ?? ''
    sortables.push(
      Sortable.create(el, {
        handle: '.mgrip',
        animation: 150,
        onEnd: (e) => onSegReorder(key, e.oldIndex, e.newIndex),
      }),
    )
  }
}

function parseKey(key: string): GroupRef {
  const [sourceId, groupId] = key.split('|')
  return { sourceId: sourceId ?? '', groupId: groupId ?? '' }
}

// groupOrder の並べ替え。indices は visibleRefs (実在 group) 基準。非表示 ref は温存。
function onGroupReorder(oldIndex?: number, newIndex?: number): void {
  if (oldIndex == null || newIndex == null || oldIndex === newIndex) return
  const visible = visibleRefs()
  const [moved] = visible.splice(oldIndex, 1)
  if (!moved) return
  visible.splice(newIndex, 0, moved)
  const rest = config.groupOrder.filter((r) => !statusGroup(r.sourceId, r.groupId))
  config.groupOrder = [...visible, ...rest]
  void saveConfig(config)
  updatePreview()
}

function onSegReorder(key: string, oldIndex?: number, newIndex?: number): void {
  const ref = parseKey(key)
  const gcfg = config.groups[ref.sourceId]?.[ref.groupId]
  if (!gcfg || oldIndex == null || newIndex == null || oldIndex === newIndex) return
  const [moved] = gcfg.segments.splice(oldIndex, 1)
  if (!moved) return
  gcfg.segments.splice(newIndex, 0, moved)
  void saveConfig(config)
  updatePreview()
}

// ── イベント ──
async function onClick(e: MouseEvent): Promise<void> {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
  if (!t) return
  switch (t.dataset.action) {
    case 'home':
      view = 'home'
      render()
      break
    case 'add-source': {
      const def = addServer(config, '新しいサーバー')
      await saveConfig(config)
      editingSourceId = def.id
      testState = 'idle'
      testUrl = ''
      editMachine = null
      view = 'source-edit'
      render()
      break
    }
    case 'edit-source':
      editingSourceId = t.dataset.src ?? null
      testState = 'idle'
      testUrl = ''
      editMachine = null
      view = 'source-edit'
      render()
      break
    case 'remove-source':
      if (editingSourceId) {
        removeSource(config, editingSourceId)
        await saveConfig(config)
        setSources(config.sources)
        editingSourceId = null
        view = 'home'
        render()
      }
      break
    case 'expand': {
      const ref = parseKey(t.dataset.key ?? '')
      const gcfg = config.groups[ref.sourceId]?.[ref.groupId]
      if (gcfg) {
        gcfg.expanded = !gcfg.expanded
        await saveConfig(config)
        render()
      }
      break
    }
    case 'toggle-group': {
      const ref = parseKey(t.dataset.key ?? '')
      const gcfg = config.groups[ref.sourceId]?.[ref.groupId]
      if (gcfg) {
        gcfg.enabled = !gcfg.enabled
        await saveConfig(config)
        render()
      }
      break
    }
    case 'toggle-seg': {
      const ref = parseKey(t.dataset.key ?? '')
      const seg = config.groups[ref.sourceId]?.[ref.groupId]?.segments.find(
        (s) => s.id === t.dataset.seg,
      )
      if (seg) {
        seg.enabled = !seg.enabled
        await saveConfig(config)
        render()
      }
      break
    }
    case 'toggle-hints':
      config.glassHints = !config.glassHints
      await saveConfig(config)
      render()
      break
    case 'test':
      await runConnectionTest()
      break
    case 'help':
      window.open('/help.html', '_blank')
      break
    default:
      break
  }
}

// 編集中ソースの URL を検証・更新し、store に反映する。
async function runConnectionTest(): Promise<void> {
  const input = root?.querySelector<HTMLInputElement>('.field-row input[type="text"]')
  const url = (input?.value ?? '').trim()
  if (!url || !editingSourceId) return
  testUrl = url
  testState = 'testing'
  testError = ''
  render()
  const clean = url.replace(/\/+$/, '')
  const m = await fetchMachineFrom(clean)
  if (!m) {
    testState = 'error'
    testError = '接続に失敗しました'
    render()
    return
  }
  editMachine = m
  const src = sourceById(config, editingSourceId)
  if (src) {
    src.url = clean
    src.label = m.label
  }
  await saveConfig(config)
  testState = 'ok'
  setSources(config.sources) // store に新 URL を反映 → 取得 → onStoreUpdate で再描画
  render()
}

function onStoreUpdate(): void {
  syncAll() // 新 group を config に取り込み (永続)
  if (view !== 'home') return
  // 表示項目の構成 (status の有無で変わる) が変化したら項目リストごと再描画。
  // 値だけの更新はプレビューのみ (drag を壊さない)。
  // ※ config に group が永続済みでも status 到着で visible 集合が変わるため changed だけでは不十分。
  if (visibleSig() !== lastVisibleSig) render()
  else updatePreview()
}

export async function mountCompanion(el: HTMLElement): Promise<void> {
  root = el
  el.addEventListener('click', (e) => void onClick(e))
  subscribe(onStoreUpdate)

  config = await loadConfig()
  // 初回 (server ソース無し) は同一オリジンを既定の server として登録 (dev-URL / ブラウザ dev)
  if (!config.sources.some((s) => s.kind === 'server')) {
    addServer(config, 'Local', location.origin)
    await saveConfig(config)
  }
  setSources(config.sources)
  startPolling()
  startClock()
  render()
}

// bridge 接続後: 永続 config を読み直して store に反映する。
export async function onCompanionBridgeReady(): Promise<void> {
  config = await loadConfig()
  if (!config.sources.some((s) => s.kind === 'server')) {
    addServer(config, 'Local', location.origin)
    await saveConfig(config)
  }
  setSources(config.sources)
  render()
}
