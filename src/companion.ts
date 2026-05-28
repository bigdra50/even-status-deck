import Sortable from 'sortablejs'
import {
  addServer,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SEG_LABELS,
  BUILTIN_SOURCE_ID,
  type Config,
  emptyConfig,
  type GAlign,
  type GlassRow,
  type GroupRef,
  generateGlassLayout,
  genSourceId,
  loadConfig,
  removeSource,
  type SegCfg,
  saveConfig,
  sourceById,
  syncSourceWithStatus,
} from './config'
import { fetchMachineFrom, type MachineInfo } from './data'
import { esc } from './escape'
import { type GlassData, MAX_ROWS, summarySections } from './glass-render'
import { icon } from './icons'
import type { Group, Segment } from './status-types'
import { getAllStatuses, getSourceStatus, setSources, startPolling, subscribe } from './store'
import { computeVisible, segKey, type VisibilityLeaf } from './visibility'

// 1 segment が持てる条件 leaf の上限 (UI が破綻しない緩い上限)。
const MAX_CONDS = 4

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

// glass layout の編集モード (GLASS PREVIEW を WYSIWYG 編集面にする / 普段は view)。
let layoutEditing = false

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
// glass と同じく top/bottom セクションに分け、bottom は画面下端へ寄せる (.gsec-bot)。
function glassPreviewHtml(): string {
  const visible = computeVisible(config, getAllStatuses())
  const { top, bottom } = summarySections(glassData(), visible)
  if (top.length + bottom.length === 0) top.push('(no metric)')
  const row = (l: string) => `<span class="grow">${esc(l)}</span>`
  const hint = config.glassHints ? '<span class="grow ghint">swipe: detail  tap: back</span>' : ''
  return `<div class="glass-screen"><div class="gsec gsec-top">${top.map(row).join('')}</div><div class="gsec gsec-bot">${bottom.map(row).join('')}${hint}</div></div>`
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))
}

// 1 leaf 行 (kind select + params + 削除ボタン)。threshold は percent を持つ segment のみ候補。
// 既存 threshold leaf は percent が無くても候補に残す (data 移行後の編集を壊さない)。
function leafRow(seg2: string, leaf: VisibilityLeaf, i: number, hasPct: boolean): string {
  const a = `${seg2} data-idx="${i}"`
  const allowThreshold = hasPct || leaf.kind === 'threshold'
  const kindSel = `<select class="vis-select" data-action="seg-vis-leaf-kind" ${a}>
    ${allowThreshold ? `<option value="threshold" ${leaf.kind === 'threshold' ? 'selected' : ''}>When…</option>` : ''}
    <option value="onChange" ${leaf.kind === 'onChange' ? 'selected' : ''}>On update</option>
  </select>`
  const params =
    leaf.kind === 'threshold'
      ? `<select class="vis-select" data-action="seg-vis-leaf-op" ${a}>
          <option value="gte" ${leaf.op === 'gte' ? 'selected' : ''}>≥</option>
          <option value="lte" ${leaf.op === 'lte' ? 'selected' : ''}>≤</option>
        </select>
        <input class="vis-num" type="number" min="0" max="100" data-action="seg-vis-leaf-value" ${a} value="${leaf.value}" />%`
      : `<input class="vis-num" type="number" min="1" max="60" data-action="seg-vis-leaf-hold" ${a} value="${Math.round(leaf.holdMs / 1000)}" />s`
  const del = `<button class="vis-del" data-action="seg-vis-remove" ${a} title="Remove" aria-label="Remove">${icon('x', { size: 14 })}</button>`
  return `<div class="vis-cond-row">${kindSel}${params}${del}</div>`
}

// segment 単位の表示タイミング条件エディタ (metric 行のサブ行)。metric は self (その segment 自身)。
// leaf を AND/OR で複合。conditions 空 = 常時表示。2 件以上で combinator(All of/Any of) を出す。
function segVisEditor(key: string, sc: SegCfg, seg: Segment): string {
  const seg2 = `data-key="${key}" data-seg="${esc(sc.id)}"`
  const hasPct = typeof seg.percent === 'number'
  const conditions = sc.visibility?.conditions ?? []
  const combinator = sc.visibility?.combinator ?? 'and'
  const head =
    conditions.length >= 2
      ? `<select class="vis-select" data-action="seg-vis-combinator" ${seg2}>
          <option value="and" ${combinator === 'and' ? 'selected' : ''}>All of</option>
          <option value="or" ${combinator === 'or' ? 'selected' : ''}>Any of</option>
        </select>`
      : `<span class="vis-always">${conditions.length === 0 ? 'always' : 'when'}</span>`
  const rows = conditions.map((l, i) => leafRow(seg2, l, i, hasPct)).join('')
  const add =
    conditions.length < MAX_CONDS
      ? `<button class="vis-add" data-action="seg-vis-add" ${seg2}>${icon('plus', { size: 13 })} Add condition</button>`
      : ''
  return `<div class="vis-row" ${seg2}><span class="vis-label">Show</span>${head}</div>
    <div class="vis-conds">${rows}${add}</div>`
}

function groupRow(ref: GroupRef): string {
  const g = statusGroup(ref.sourceId, ref.groupId)
  const gcfg = config.groups[ref.sourceId]?.[ref.groupId]
  if (!g || !gcfg) return ''
  const src = sourceById(config, ref.sourceId)
  const isBuiltin = ref.sourceId === BUILTIN_SOURCE_ID
  const key = `${esc(ref.sourceId)}|${esc(ref.groupId)}`
  // builtin の行名はコード所有ラベル (BUILTIN_GROUP_LABELS) を使い、永続 source label に依存しない。
  const title = isBuiltin
    ? (BUILTIN_GROUP_LABELS[ref.groupId] ?? ref.groupId)
    : g.label || src?.label || ref.groupId
  const caret = icon(gcfg.expanded ? 'chevron-down' : 'chevron-right', { size: 16 })
  const segById = new Map(g.segments.map((s) => [s.id, s]))
  const metrics = gcfg.expanded
    ? `<div class="src-metrics" data-key="${key}">${gcfg.segments
        .map((sc) => {
          const seg = segById.get(sc.id)
          if (!seg) return ''
          return `<div class="metric"><div class="metric-row"><span class="mgrip">${icon('grip', { size: 16 })}</span>
              <span class="mname">${esc(isBuiltin ? (BUILTIN_SEG_LABELS[seg.id] ?? seg.id) : seg.label || seg.id)}</span>
              <span class="mval">${esc(seg.value)}</span>
              <button class="tg sm ${sc.enabled ? 'on' : ''}" data-action="toggle-seg" data-key="${key}" data-seg="${esc(sc.id)}"></button></div>
            ${segVisEditor(key, sc, seg)}</div>`
        })
        .join('')}</div>`
    : ''
  const srcTag = isBuiltin
    ? ''
    : src && src.id !== ref.sourceId
      ? ''
      : src
        ? `<span class="src-note">${esc(src.label)}</span>`
        : ''
  const bottom = gcfg.align === 'bottom'
  const alignBtn = `<button class="align-btn ${bottom ? 'bottom' : ''}" data-action="toggle-align" data-key="${key}" title="${bottom ? 'Bottom-aligned' : 'Top-aligned'}">${icon(bottom ? 'align-bottom' : 'align-top', { size: 16 })}</button>`
  return `<div class="src" data-key="${key}"><div class="src-head"><span class="src-grip">${icon('grip', { size: 16 })}</span>
    <span class="src-caret" data-action="expand" data-key="${key}">${caret}</span>
    <span class="src-name" data-action="expand" data-key="${key}">${esc(title)}</span>
    ${srcTag}
    ${alignBtn}
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
      <span class="src-name">${esc(s.label)}</span><span class="src-note">Built-in</span></div></div>`
  }
  const online = getSourceStatus(s.id) != null
  return `<div class="src"><div class="src-head"><span class="conn-dot ${online ? '' : 'off'}"></span>
    <span class="src-name">${esc(s.label)}</span>
    <span class="src-note">${esc(s.url ?? 'Not set')}</span>
    <button class="gear-btn" data-action="edit-source" data-src="${esc(s.id)}" title="Edit" aria-label="Edit">${icon('settings', { size: 18 })}</button></div></div>`
}

// ── Glass layout (表示レシピ。group=素材 とは独立した行配置) ──
// segKey → companion chip 用の {group, seg} ラベル (builtin は code-owned)。
function segLabelParts(key: string): { group: string; seg: string } {
  const [sourceId, groupId, segId] = key.split('|')
  if (sourceId === BUILTIN_SOURCE_ID) {
    return {
      group: BUILTIN_GROUP_LABELS[groupId] ?? groupId,
      seg: BUILTIN_SEG_LABELS[segId] ?? segId,
    }
  }
  const g = statusGroup(sourceId, groupId)
  const seg = g?.segments.find((s) => s.id === segId)
  return {
    group: g?.label || sourceById(config, sourceId)?.label || groupId,
    seg: seg?.label || segId,
  }
}

// enabled な全 segment の segKey (groupOrder 順)。未配置リストの母集合。
function allEnabledSegKeys(): string[] {
  const keys: string[] = []
  for (const ref of config.groupOrder) {
    const gc = config.groups[ref.sourceId]?.[ref.groupId]
    if (!gc) continue
    for (const sc of gc.segments) {
      if (sc.enabled) keys.push(segKey(ref.sourceId, ref.groupId, sc.id))
    }
  }
  return keys
}

// row が glass 1 行に収まらなさそうか (proportional のため概算文字数 40 を目安)。
function rowOverflow(row: GlassRow): boolean {
  let len = 0
  let n = 0
  for (const key of row.items) {
    const [sourceId, groupId, segId] = key.split('|')
    const seg = statusGroup(sourceId, groupId)?.segments.find((s) => s.id === segId)
    if (!seg) continue
    len += (seg.label ? seg.label.length + 1 : 0) + seg.value.length
    n++
  }
  return len + Math.max(0, n - 1) * 2 > 40
}

// glass に表示できる行数の上限。MAX_ROWS から hint 行 (glassHints ON 時) を引く。
// 1 行 = glass の 1 行を消費するので、row 総数はこれを超えられない (超過分は glass で … 省略)。
function glassRowBudget(): number {
  return MAX_ROWS - (config.glassHints ? 1 : 0)
}

// WYSIWYG の segment chip。グラス上に置く編集要素 (grip + ラベル + 除去×)。
function wysChip(key: string): string {
  const { group, seg } = segLabelParts(key)
  const label = group ? `${group} ${seg}` : seg
  return `<span class="wys-chip" data-segkey="${esc(key)}" title="${esc(label)}"><span class="wys-grip">${icon('grip', { size: 11 })}</span><span class="wys-txt">${esc(seg)}</span><button class="wys-x" data-action="layout-item-remove" data-segkey="${esc(key)}" aria-label="Unplace">${icon('x', { size: 10 })}</button></span>`
}

// WYSIWYG の 1 行 (chip コンテナ + 行操作: 上下反転 / 削除)。
function wysRow(row: GlassRow): string {
  const chips = row.items.map(wysChip).join('')
  const flip = `<button class="wys-row-btn" data-action="layout-row-anchor" data-row-id="${esc(row.id)}" title="${row.anchor === 'bottom' ? 'Move to top' : 'Move to bottom'}">${icon(row.anchor === 'bottom' ? 'align-top' : 'align-bottom', { size: 12 })}</button>`
  const del = `<button class="wys-row-btn" data-action="layout-row-remove" data-row-id="${esc(row.id)}" aria-label="Remove row">${icon('x', { size: 12 })}</button>`
  const warn = rowOverflow(row)
    ? `<span class="wys-over" title="1 行に長すぎる可能性">${icon('alert', { size: 12 })}</span>`
    : ''
  return `<div class="wys-row" data-row-id="${esc(row.id)}"><div class="wys-items" data-row-id="${esc(row.id)}">${chips}</div><span class="wys-row-ctl">${warn}${flip}${del}</span></div>`
}

// 編集モードのキャンバス (top/bottom ゾーン) + 棚 + 行追加 / Reset。
function renderGlassEdit(lay: NonNullable<Config['glassLayout']>): string {
  const top = lay.rows.filter((r) => r.anchor !== 'bottom')
  const bot = lay.rows.filter((r) => r.anchor === 'bottom')
  const placed = new Set(lay.rows.flatMap((r) => r.items))
  const unplaced = allEnabledSegKeys().filter((k) => !placed.has(k))
  const zone = (rows: GlassRow[], cls: string, empty: string) =>
    `<div class="wys-zone ${cls}">${rows.map(wysRow).join('') || `<div class="wys-empty">${empty}</div>`}</div>`
  const shelf = unplaced.length
    ? unplaced.map(wysChip).join('')
    : '<span class="cmp-sub">未配置なし</span>'
  const budget = glassRowBudget()
  const full = lay.rows.length >= budget // glass の表示行数上限に到達 (これ以上は描画されない)
  const dis = full ? 'disabled' : ''
  const count = full
    ? `<span class="wys-rowcount over">${lay.rows.length}/${budget} rows (max — glass は ${budget} 行まで)</span>`
    : `<span class="wys-rowcount">${lay.rows.length}/${budget} rows</span>`
  return `<div class="gpv"><div class="gpv-cap">G2 576×288 — editing</div>
      <div class="gpv-screen wys-screen">
        ${zone(top, 'wys-top', 'top rows (上寄せ)')}
        ${zone(bot, 'wys-bot', 'bottom rows (下寄せ)')}
      </div></div>
    <div class="wys-bar">
      <button class="save-btn sm" data-action="layout-row-add" data-anchor="top" ${dis}>${icon('plus', { size: 14 })}Top row</button>
      <button class="save-btn sm" data-action="layout-row-add" data-anchor="bottom" ${dis}>${icon('plus', { size: 14 })}Bottom row</button>
      ${count}
    </div>
    <div class="cmp-label">Unplaced</div>
    <div class="wys-items wys-shelf" data-shelf="1">${shelf}</div>
    <button class="danger-btn" data-action="layout-reset">Reset to auto</button>`
}

// Glass セクション: プレビュー一本。view は実機同等の連結テキスト、edit は WYSIWYG。
function renderGlassSection(): string {
  const lay = config.glassLayout
  if (!lay) {
    return `<div class="cmp-label">Glass</div>
      <div class="gpv"><div class="gpv-cap">G2 576×288</div><div class="gpv-screen">${glassPreviewHtml()}</div></div>
      <div class="cmp-sub">各 group を 1 行ずつ表示中。Customize するとプレビュー上で自由に配置できます。</div>
      <button class="save-btn" data-action="layout-customize">${icon('plus', { size: 16 })}Customize layout</button>`
  }
  if (layoutEditing) {
    return `<div class="cmp-label cmp-label-row">Glass layout<button class="link-btn" data-action="layout-edit-toggle">Done</button></div>
      <div class="cmp-sub">segment をグラス上の行間・棚へドラッグ。上段=上寄せ / 下段=下寄せ。</div>
      ${renderGlassEdit(lay)}`
  }
  return `<div class="cmp-label cmp-label-row">Glass<button class="link-btn" data-action="layout-edit-toggle">Edit layout</button></div>
    <div class="gpv"><div class="gpv-cap">G2 576×288</div><div class="gpv-screen">${glassPreviewHtml()}</div></div>`
}

function renderHome(): string {
  // builtin (Clock/G2 Battery) は SOURCES に出さない。設定するサーバ専用のリストにする。
  const sources = config.sources
    .filter((s) => s.kind !== 'builtin')
    .map((s) => sourceRow(s))
    .join('')
  return `
    <div class="cmp-label">Sources</div>
    ${sources}
    <button class="save-btn" data-action="add-source">${icon('plus', { size: 16 })}Add server</button>

    <div class="cmp-label">Items (drag ${icon('grip', { size: 12 })} to reorder)</div>
    <div id="source-list">${renderItems()}</div>
    <div class="src"><div class="src-head">
      <span class="src-name" style="font-size:var(--fs-md);font-weight:500;">Show glass hints</span>
      <button class="tg sm ${config.glassHints ? 'on' : ''}" data-action="toggle-hints"></button></div></div>

    ${renderGlassSection()}
  `
}

// ── ソース編集 ──
function renderDetected(): string {
  const m = editMachine
  if (!m) return ''
  return `<div class="field"><label>Machine name</label><div class="autoval">${esc(m.label)}</div></div>
     <div class="field"><label>machineId</label><div class="autoval mono">${esc(m.machineId)}</div></div>`
}

function renderTestStatus(): string {
  if (testState === 'testing')
    return `<div class="status-testing">${icon('loader', { size: 14, cls: 'ic-spin' })} Connecting…</div>`
  if (testState === 'ok')
    return `<div class="status-ok">${icon('check', { size: 14 })} Connected</div>${renderDetected()}`
  if (testState === 'error')
    return `<div class="status-err">${icon('x', { size: 14 })} Failed: ${esc(testError)}</div>
      <div class="cmp-sub">Check the URL and that the server is running.</div>`
  return '<div class="cmp-sub">Test the connection to load items.</div>'
}

function renderSourceEdit(): string {
  const s = editingSourceId ? sourceById(config, editingSourceId) : undefined
  const url = testUrl || s?.url || 'http://127.0.0.1:8723'
  const testing = testState === 'testing'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">${icon('arrow-left', { size: 16 })} Home</button>
      <span class="h-title">Server</span><span></span></div>
    <div class="field"><label>URL</label>
      <div class="field-row">
        <input type="text" value="${esc(url)}" placeholder="http://127.0.0.1:8723" />
        <button class="test-btn" data-action="test" ${testing ? 'disabled' : ''}>${testing ? '…' : 'Test'}</button>
      </div>
      <span class="help-link" data-action="help">Set up a local server ${icon('external-link', { size: 13 })}</span>
    </div>
    ${renderTestStatus()}
    <button class="danger-btn" data-action="remove-source">Remove source</button>
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
  // 編集モードの WYSIWYG キャンバス (.wys-screen) は上書きしない (view の連結テキストのみ更新)。
  const el = root?.querySelector('.gpv-screen')
  if (el && !el.classList.contains('wys-screen')) el.innerHTML = glassPreviewHtml()
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
  // WYSIWYG: グラス上の行 + 棚を跨いで segment chip をドラッグ (共有 group)。
  // forceFallback: iOS WKWebView では HTML5 DnD が touch で動かないため必須。
  if (layoutEditing) {
    for (const el of document.querySelectorAll<HTMLElement>('.wys-items')) {
      sortables.push(
        Sortable.create(el, {
          group: 'wys',
          handle: '.wys-grip',
          animation: 150,
          forceFallback: true,
          onEnd: () => recomputeWysFromDom(),
        }),
      )
    }
  }
}

// ドラッグ後、WYSIWYG キャンバスの DOM から glassLayout.rows を再構築する。
// anchor は所属ゾーン (top/bottom) から決まる。棚 (data-shelf) の chip は items から外れる。
function recomputeWysFromDom(): void {
  if (!config.glassLayout) return
  const rows: GlassRow[] = []
  const readZone = (sel: string, anchor: GAlign) => {
    for (const el of document.querySelectorAll<HTMLElement>(`${sel} .wys-items[data-row-id]`)) {
      const id = el.dataset.rowId ?? ''
      const items = [...el.querySelectorAll<HTMLElement>('.wys-chip')]
        .map((c) => c.dataset.segkey ?? '')
        .filter(Boolean)
      rows.push({ id, anchor, items })
    }
  }
  readZone('.wys-top', 'top')
  readZone('.wys-bot', 'bottom')
  config.glassLayout = { rows }
  void saveConfig(config)
  render()
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
      const def = addServer(config, 'New server')
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
    case 'toggle-align': {
      const ref = parseKey(t.dataset.key ?? '')
      const gcfg = config.groups[ref.sourceId]?.[ref.groupId]
      if (gcfg) {
        gcfg.align = gcfg.align === 'bottom' ? 'top' : 'bottom'
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
    case 'seg-vis-add': {
      const ref = parseKey(t.dataset.key ?? '')
      const sc = config.groups[ref.sourceId]?.[ref.groupId]?.segments.find(
        (s) => s.id === t.dataset.seg,
      )
      if (sc) {
        const seg = statusGroup(ref.sourceId, ref.groupId)?.segments.find(
          (s) => s.id === t.dataset.seg,
        )
        const hasPct = typeof seg?.percent === 'number'
        const cond = sc.visibility ?? { combinator: 'and', conditions: [] }
        if (cond.conditions.length < MAX_CONDS) {
          cond.conditions.push(
            hasPct
              ? { kind: 'threshold', op: 'gte', value: 80 }
              : { kind: 'onChange', holdMs: 5000 },
          )
          sc.visibility = cond
          await saveConfig(config)
          render()
        }
      }
      break
    }
    case 'seg-vis-remove': {
      const ref = parseKey(t.dataset.key ?? '')
      const sc = config.groups[ref.sourceId]?.[ref.groupId]?.segments.find(
        (s) => s.id === t.dataset.seg,
      )
      const idx = Number(t.dataset.idx)
      if (sc?.visibility && Number.isInteger(idx)) {
        sc.visibility.conditions.splice(idx, 1)
        if (sc.visibility.conditions.length === 0) sc.visibility = undefined
        await saveConfig(config)
        render()
      }
      break
    }
    case 'layout-edit-toggle':
      layoutEditing = !layoutEditing
      render()
      break
    case 'layout-customize':
      config.glassLayout = generateGlassLayout(config)
      layoutEditing = true // 生成と同時に編集モードへ
      await saveConfig(config)
      render()
      break
    case 'layout-reset':
      config.glassLayout = undefined
      layoutEditing = false
      await saveConfig(config)
      render()
      break
    case 'layout-row-add':
      // glass の表示行数 (budget) を超える行は追加させない (超過分は glass に出ない)。
      if (config.glassLayout && config.glassLayout.rows.length < glassRowBudget()) {
        const anchor: GAlign = t.dataset.anchor === 'bottom' ? 'bottom' : 'top'
        config.glassLayout.rows.push({ id: genSourceId(), anchor, items: [] })
        await saveConfig(config)
        render()
      }
      break
    case 'layout-row-remove': {
      const id = t.dataset.rowId
      if (config.glassLayout && id) {
        config.glassLayout.rows = config.glassLayout.rows.filter((r) => r.id !== id)
        await saveConfig(config)
        render()
      }
      break
    }
    case 'layout-row-anchor': {
      const row = config.glassLayout?.rows.find((r) => r.id === t.dataset.rowId)
      if (row) {
        row.anchor = row.anchor === 'bottom' ? 'top' : 'bottom'
        await saveConfig(config)
        render()
      }
      break
    }
    case 'layout-item-remove': {
      const key = t.dataset.segkey
      if (config.glassLayout && key) {
        for (const r of config.glassLayout.rows) r.items = r.items.filter((k) => k !== key)
        await saveConfig(config)
        render()
      }
      break
    }
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

// segment 条件エディタ (combinator select / leaf の kind・op・value・hold) の変更を
// config.groups[*][*].segments[*].visibility に反映する。leaf は data-idx で特定する。
async function onSegVisChange(e: Event): Promise<void> {
  const t = e.target as HTMLInputElement | HTMLSelectElement
  const action = t.dataset.action
  const key = t.dataset.key
  const segId = t.dataset.seg
  if (!action?.startsWith('seg-vis-') || !key || !segId) return
  const ref = parseKey(key)
  const sc = config.groups[ref.sourceId]?.[ref.groupId]?.segments.find((s) => s.id === segId)
  const vis = sc?.visibility
  if (!vis) return
  const val = t.value
  if (action === 'seg-vis-combinator') {
    vis.combinator = val === 'or' ? 'or' : 'and'
  } else {
    const idx = Number(t.dataset.idx)
    const leaf = vis.conditions[idx]
    if (!leaf) return
    switch (action) {
      case 'seg-vis-leaf-kind':
        vis.conditions[idx] =
          val === 'threshold'
            ? { kind: 'threshold', op: 'gte', value: 80 }
            : { kind: 'onChange', holdMs: 5000 }
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
      default:
        return
    }
  }
  await saveConfig(config)
  render()
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
    testError = 'Connection failed'
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
  // 表示項目の構成 (status の有無で変わる) が変化したときだけ項目リストを再描画。
  // 値だけの更新では再描画しない (毎 poll の innerHTML churn が iOS WebContent jettison を招くため。
  // プレビューはモックなので値追従はユーザー編集/構成変化/並べ替えで十分。issue #4)。
  if (visibleSig() !== lastVisibleSig) render()
}

export async function mountCompanion(el: HTMLElement): Promise<void> {
  root = el
  el.addEventListener('click', (e) => void onClick(e))
  el.addEventListener('change', (e) => void onSegVisChange(e)) // segment 条件エディタの select/number
  subscribe(onStoreUpdate)

  config = await loadConfig()
  // 初回 (server ソース無し) は同一オリジンを既定の server として登録 (dev-URL / ブラウザ dev)
  if (!config.sources.some((s) => s.kind === 'server')) {
    addServer(config, 'Local', location.origin)
    await saveConfig(config)
  }
  setSources(config.sources)
  startPolling()
  render() // 時刻 (clock) は glass-local タイマーが所有。companion は周期再描画しない
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
