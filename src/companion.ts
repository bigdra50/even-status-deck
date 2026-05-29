import Sortable from 'sortablejs'
import {
  CLOCK_DATE_OPTS,
  CLOCK_SEG,
  CLOCK_TIME_OPTS,
  composeClockFormat,
  defaultClockFormat,
  localStatus,
  parseClockFormat,
} from './builtins'
import {
  addServer,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SEG_LABELS,
  BUILTIN_SOURCE_ID,
  type Config,
  customLabelId,
  customLabelKey,
  emptyConfig,
  ensureDefaultServer,
  type GroupRef,
  generateGlassLayout,
  genLabelId,
  isCustomLabelKey,
  isRightDivider,
  loadConfig,
  RIGHT_DIVIDER,
  removeSource,
  type SegCfg,
  saveConfig,
  sourceById,
  syncSourceWithStatus,
} from './config'
import { fetchMachineFrom, type MachineInfo } from './data'
import { esc } from './escape'
import {
  type GlassData,
  layoutRowClusters,
  MAX_ROWS,
  splitRowClusters,
  summarySections,
} from './glass-render'
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

// builtin (clock/g2) は config の format/widthChars を反映した live 値で上書きする
// (store の builtin は config 非依存の既定値なので、プレビュー/Items を選択に追従させる)。
function glassData(): GlassData {
  return { config, statuses: { ...getAllStatuses(), [BUILTIN_SOURCE_ID]: localStatus(config) } }
}

function statusGroup(sourceId: string, groupId: string): Group | undefined {
  const doc = sourceId === BUILTIN_SOURCE_ID ? localStatus(config) : getSourceStatus(sourceId)
  return doc?.groups.find((g) => g.id === groupId)
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
// custom (glassLayout あり): 固定行を絶対位置で描画 (空行も保持。上詰め/下詰めは無い)。
// auto (未カスタマイズ): 従来の group=1行 + top/bottom 詰め。glass には操作ヒントを出さない。
function glassPreviewHtml(): string {
  const visible = computeVisible(config, getAllStatuses())
  const d = glassData()
  const grow = (l: string) => `<span class="grow">${l ? esc(l) : '&nbsp;'}</span>`
  if (config.glassLayout) {
    // 各行を左右クラスタで表示。右クラスタがあれば flex space-between で右端へ寄せる
    // (実機の space 近似と違い、プレビューは px 量子化せず正確に左右配置する)。
    const row = ({ left, right }: { left: string; right: string }) =>
      right
        ? `<div class="grow gjust"><span>${left ? esc(left) : ''}</span><span class="gj-r">${esc(right)}</span></div>`
        : grow(left)
    return `<div class="glass-screen">${layoutRowClusters(d, visible, MAX_ROWS).map(row).join('')}</div>`
  }
  const { top, bottom } = summarySections(d, visible)
  if (top.length + bottom.length === 0) top.push('(no metric)')
  return `<div class="glass-screen"><div class="gsec gsec-top">${top.map(grow).join('')}</div><div class="gsec gsec-bot">${bottom.map(grow).join('')}</div></div>`
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

// clock (datetime) segment の合成フォーマット UI: Time / Date / 順序 の 3 select。
// 現在の SegCfg.format (無ければロケール既定) を逆解析して選択状態を復元する。
function clockFormatControls(key: string, sc: SegCfg): string {
  const cur = parseClockFormat(sc.format ?? defaultClockFormat())
  const opt = (o: { format: string; label: string }, selected: string) =>
    `<option value="${esc(o.format)}" ${o.format === selected ? 'selected' : ''}>${esc(o.label)}</option>`
  const time = CLOCK_TIME_OPTS.map((o) => opt(o, cur.time)).join('')
  const date = CLOCK_DATE_OPTS.map((o) => opt(o, cur.date)).join('')
  const a = `data-key="${key}" data-seg="${esc(sc.id)}"`
  return `<div class="clock-ctl">
    <label class="clock-fld">Time<select class="format-select" data-action="clock-time" ${a}>${time}</select></label>
    <label class="clock-fld">Date<select class="format-select" data-action="clock-date" ${a}>${date}</select></label>
    <label class="clock-fld">Order<select class="format-select" data-action="clock-order" ${a}>
      <option value="time" ${cur.order === 'time' ? 'selected' : ''}>Time → Date</option>
      <option value="date" ${cur.order === 'date' ? 'selected' : ''}>Date → Time</option>
    </select></label>
  </div>`
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
          // clock の datetime segment は Time/Date/順序 の合成フォーマット UI を出す。
          const isClock = isBuiltin && ref.groupId === 'clock' && sc.id === CLOCK_SEG
          return `<div class="metric"><div class="metric-row"><span class="mgrip">${icon('grip', { size: 16 })}</span>
              <span class="mname">${esc(isBuiltin ? (BUILTIN_SEG_LABELS[seg.id] ?? seg.id) : seg.label || seg.id)}</span>
              <span class="mval">${esc(seg.value)}</span>
              <button class="tg sm ${sc.enabled ? 'on' : ''}" data-action="toggle-seg" data-key="${key}" data-seg="${esc(sc.id)}"></button></div>
            ${isClock ? clockFormatControls(key, sc) : ''}
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
  // default-label トグル (glass で group 名を前置するか)。位置/上詰めは Glass layout で決める。
  const showsLabel = gcfg.showDefaultLabel ?? ref.groupId !== 'clock'
  const labelBtn = `<button class="label-btn ${showsLabel ? 'on' : ''}" data-action="toggle-grouplabel" data-key="${key}" title="${showsLabel ? 'Group label shown on glass' : 'Group label hidden'}">${icon('tag', { size: 15 })}</button>`
  return `<div class="src" data-key="${key}"><div class="src-head"><span class="src-grip">${icon('grip', { size: 16 })}</span>
    <span class="src-caret" data-action="expand" data-key="${key}">${caret}</span>
    <span class="src-name" data-action="expand" data-key="${key}">${esc(title)}</span>
    ${srcTag}
    ${labelBtn}
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

// 配置可能な全 key (groupOrder 順)。未配置リストの母集合。
// group ラベルは default-label (group 単位トグル) が自動で出すので chip にはしない。
function allPlaceableKeys(): string[] {
  const keys: string[] = []
  for (const ref of config.groupOrder) {
    const gc = config.groups[ref.sourceId]?.[ref.groupId]
    if (!gc) continue
    for (const sc of gc.segments) {
      if (sc.enabled) keys.push(segKey(ref.sourceId, ref.groupId, sc.id))
    }
  }
  // ユーザー定義の custom ラベル
  for (const id of Object.keys(config.glassLayout?.customLabels ?? {}))
    keys.push(customLabelKey(id))
  return keys
}

// 行 (key 配列) が glass 1 行 (等幅近似で ~50 桁) に収まらなさそうか。
// segment は widthChars (確保枠) 優先、無ければ value 長。custom ラベルはテキスト長。
// group default-label の前置分も run 先頭で加算 (rowText の dedup と合わせる)。
const ROW_MAX_CHARS = 50
function rowOverflow(items: string[]): boolean {
  let total = 0
  let n = 0
  let prevGroup: string | null = null
  for (const key of items) {
    if (isCustomLabelKey(key)) {
      const text = config.glassLayout?.customLabels[customLabelId(key)]?.text ?? ''
      if (!text) continue
      total += text.length
      prevGroup = null
      n++
      continue
    }
    const [sourceId, groupId, segId] = key.split('|')
    const seg = statusGroup(sourceId, groupId)?.segments.find((s) => s.id === segId)
    if (!seg) continue
    const gc = config.groups[sourceId]?.[groupId]
    // 無効化された segment は glass(rowText) で描画されないので幅計算からも除外 (過大評価防止)。
    if (!gc?.segments.find((s) => s.id === segId)?.enabled) continue
    const labelLen = seg.label ? seg.label.length + 1 : 0
    const valLen = seg.widthChars ?? seg.value.length
    let w = labelLen + valLen
    const showsLabel = gc?.showDefaultLabel ?? groupId !== 'clock'
    if (showsLabel && groupId !== prevGroup) {
      const { group } = segLabelParts(key)
      if (group) w += group.length + 1 // run 先頭の group 名前置
    }
    total += w
    prevGroup = groupId
    n++
  }
  return total + Math.max(0, n - 1) * 2 > ROW_MAX_CHARS
}

// WYSIWYG の chip。custom ラベル (自由テキスト) と segment 値 chip の 2 種。
// 値 chip は実機の表示文字列 (label value / value)。group の default-label が ON なら
// group 名を小さく添える (実機で前置されるラベルを editor で可視化。OFF なら出さない)。
function wysChip(key: string): string {
  const grip = `<span class="wys-grip">${icon('grip', { size: 11 })}</span>`
  // custom ラベル: × は削除 (customLabels から除去)。値 chip の × は unplace。
  if (isCustomLabelKey(key)) {
    const id = customLabelId(key)
    const text = config.glassLayout?.customLabels[id]?.text ?? ''
    const del = `<button class="wys-x" data-action="label-delete" data-label-id="${esc(id)}" title="Delete label" aria-label="Delete label">${icon('x', { size: 10 })}</button>`
    return `<span class="wys-chip wys-label-chip wys-custom-chip" data-segkey="${esc(key)}" title="${esc(text)}">${grip}<span class="wys-txt">${esc(text)}</span>${del}</span>`
  }
  const [sourceId, groupId, segId] = key.split('|')
  const { group, seg } = segLabelParts(key)
  const x = `<button class="wys-x" data-action="layout-item-remove" data-segkey="${esc(key)}" aria-label="Unplace">${icon('x', { size: 10 })}</button>`
  const sg = statusGroup(sourceId, groupId)?.segments.find((s) => s.id === segId)
  const text = sg ? (sg.label ? `${sg.label} ${sg.value}` : sg.value) : seg
  // default-label ON の group のみ group 名を薄く前置表示 (実機の前置ラベルに対応)
  const gc = config.groups[sourceId]?.[groupId]
  const showsLabel = gc?.showDefaultLabel ?? groupId !== 'clock'
  const grp = group && showsLabel ? `<span class="wys-grp">${esc(group)}</span>` : ''
  return `<span class="wys-chip" data-segkey="${esc(key)}" title="${esc(group ? `${group} ${seg}` : seg)}">${grip}${grp}<span class="wys-txt">${esc(text)}</span>${x}</span>`
}

// 編集モードのキャンバス: 固定 MAX_ROWS 行 (行番号ガター + 左/右ゾーン) + 未配置棚 + Reset。
// 行番号 = glass の上からの絶対位置。glass にヒント行は出さないので予約行も無い (全行配置可)。
// 各行は左ゾーン｜右ゾーンの 2 ドロップ領域。右ゾーンに置いた chip は実機で右寄せされる。
function renderGlassEdit(lay: NonNullable<Config['glassLayout']>): string {
  const placed = new Set(lay.rows.flat().filter((k) => !isRightDivider(k)))
  const unplaced = allPlaceableKeys().filter((k) => !placed.has(k))
  const lines: string[] = []
  for (let i = 0; i < MAX_ROWS; i++) {
    const row = lay.rows[i] ?? []
    const { left, right } = splitRowClusters(row)
    const lc = left.map(wysChip).join('')
    const rc = right.map(wysChip).join('')
    const warn = rowOverflow(row)
      ? `<span class="wys-over" title="May be too long for one line">${icon('alert', { size: 12 })}</span>`
      : ''
    lines.push(
      `<div class="wys-line"><span class="wys-ln">${i + 1}</span>` +
        `<div class="wys-cell wys-zone" data-row="${i}" data-zone="left" title="Left">${lc}</div>` +
        `<span class="wys-zone-sep" title="Left ｜ Right"></span>` +
        `<div class="wys-cell wys-zone wys-zone-r" data-row="${i}" data-zone="right" title="Right">${rc}</div>` +
        `${warn}</div>`,
    )
  }
  const shelf = unplaced.length
    ? unplaced.map(wysChip).join('')
    : '<span class="cmp-sub">Nothing unplaced</span>'
  return `<div class="gpv"><div class="gpv-cap">G2 576×288 — editing</div>
      <div class="gpv-screen wys-screen">${lines.join('')}</div></div>
    <div class="cmp-sub">Drag items into the left or right side of a row. Right-side items align to the right edge.</div>
    <div class="cmp-label">Unplaced</div>
    <div class="wys-cell wys-shelf" data-shelf="1">${shelf}</div>
    <div class="field-row wys-add">
      <input class="lay-add-input" type="text" maxlength="64" placeholder="Custom label (heading / divider …)" />
      <button class="save-btn sm" data-action="label-add">${icon('plus', { size: 14 })}Add label</button>
    </div>
    <button class="danger-btn" data-action="layout-reset">Reset to auto</button>`
}

// Glass セクション: プレビュー一本。view は実機同等の連結テキスト、edit は WYSIWYG。
function renderGlassSection(): string {
  const lay = config.glassLayout
  if (!lay) {
    return `<div class="cmp-label">Glass</div>
      <div class="gpv"><div class="gpv-cap">G2 576×288</div><div class="gpv-screen">${glassPreviewHtml()}</div></div>
      <div class="cmp-sub">Glass gestures: tap = summary / swipe = switch view / double-tap = exit</div>
      <div class="cmp-sub">One row per group. Customize to place items freely on the preview.</div>
      <button class="save-btn" data-action="layout-customize">${icon('plus', { size: 16 })}Customize layout</button>
      <button class="save-btn sm" data-action="fs-open">${icon('plus', { size: 14 })}Fullscreen edit (beta)</button>`
  }
  if (layoutEditing) {
    return `<div class="cmp-label cmp-label-row">Glass layout<button class="link-btn" data-action="layout-edit-toggle">Done</button></div>
      <div class="cmp-sub">Drag items to rows (1–${MAX_ROWS}) or the Unplaced shelf. Row number = position from top of glass.</div>
      ${renderGlassEdit(lay)}`
  }
  return `<div class="cmp-label cmp-label-row">Glass<span class="cmp-actions"><button class="link-btn" data-action="fs-open">Fullscreen</button><button class="link-btn" data-action="layout-edit-toggle">Edit layout</button></span></div>
    <div class="gpv"><div class="gpv-cap">G2 576×288</div><div class="gpv-screen">${glassPreviewHtml()}</div></div>
    <div class="cmp-sub">Glass gestures: tap = summary / swipe = switch view / double-tap = exit</div>`
}

function renderHome(): string {
  // builtin (Clock/G2 Battery) は SOURCES に出さない。設定するサーバ専用のリストにする。
  const sources = config.sources
    .filter((s) => s.kind !== 'builtin')
    .map((s) => sourceRow(s))
    .join('')
  return `
    <div class="cmp-label cmp-label-row">Sources<button class="add-btn" data-action="add-source" title="Add source" aria-label="Add source">${icon('plus', { size: 16 })}</button></div>
    ${sources}

    <div class="cmp-label">Items (drag ${icon('grip', { size: 12 })} to reorder)</div>
    <div id="source-list">${renderItems()}</div>

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
        delay: 200,
        delayOnTouchOnly: true, // タッチは長押しでドラッグ開始 (素早いスワイプはスクロール)
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
        delay: 200,
        delayOnTouchOnly: true,
        onEnd: (e) => onSegReorder(key, e.oldIndex, e.newIndex),
      }),
    )
  }
  // WYSIWYG: 固定行セル + 棚を跨いで segment chip をドラッグ (共有 group)。
  // forceFallback: iOS WKWebView では HTML5 DnD が touch で動かないため必須。
  // delayOnTouchOnly: タッチは長押しでドラッグ開始 (素早いスワイプはスクロールに通す)。
  // drag 中はドロップ先セルをハイライト。
  if (layoutEditing) {
    for (const el of document.querySelectorAll<HTMLElement>('.wys-cell')) {
      sortables.push(
        Sortable.create(el, {
          group: 'wys',
          handle: '.wys-grip',
          animation: 150,
          delay: 200,
          delayOnTouchOnly: true,
          forceFallback: true,
          onMove: (evt) => {
            for (const c of document.querySelectorAll('.wys-cell.drop-hot')) {
              c.classList.remove('drop-hot')
            }
            evt.to?.classList.add('drop-hot')
            return true
          },
          onEnd: () => {
            for (const c of document.querySelectorAll('.wys-cell.drop-hot')) {
              c.classList.remove('drop-hot')
            }
            recomputeWysFromDom()
          },
        }),
      )
    }
  }
}

// ドラッグ後、各行の左/右ゾーンの chip 並びから glassLayout.rows (固定 MAX_ROWS 行) を再構築する。
// 右ゾーンに chip があれば左ゾーンとの間に @right 区切りを挿む (前=左/後=右クラスタ)。
// 棚 (data-shelf) の chip はどの行にも無い = 未配置 (次の描画で棚に導出される)。
function recomputeWysFromDom(): void {
  if (!config.glassLayout) return
  const readZone = (i: number, zone: 'left' | 'right'): string[] => {
    const el = document.querySelector<HTMLElement>(
      `.wys-cell[data-row="${i}"][data-zone="${zone}"]`,
    )
    if (!el) return []
    return [...el.querySelectorAll<HTMLElement>('.wys-chip')]
      .map((c) => c.dataset.segkey ?? '')
      .filter(Boolean)
  }
  const rows: string[][] = Array.from({ length: MAX_ROWS }, (_, i) => {
    const left = readZone(i, 'left')
    const right = readZone(i, 'right')
    return right.length ? [...left, RIGHT_DIVIDER, ...right] : left
  })
  config.glassLayout = { rows, customLabels: config.glassLayout.customLabels }
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
    case 'toggle-grouplabel': {
      // glass で group 名を前置するか (default-label)。
      const ref = parseKey(t.dataset.key ?? '')
      const gcfg = config.groups[ref.sourceId]?.[ref.groupId]
      if (gcfg) {
        gcfg.showDefaultLabel = !(gcfg.showDefaultLabel ?? ref.groupId !== 'clock')
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
    case 'fs-open':
      // フルスクリーン WYSIWYG エディタ (実験的)。custom layout 未生成なら生成して開く。
      if (!config.glassLayout) {
        config.glassLayout = generateGlassLayout(config)
        await saveConfig(config)
      }
      openFsEditor()
      break
    case 'layout-item-remove': {
      // segment を全行から外す → 未配置 (Unplaced 棚) に導出される。
      const key = t.dataset.segkey
      if (config.glassLayout && key) {
        config.glassLayout.rows = config.glassLayout.rows.map((r) => r.filter((k) => k !== key))
        await saveConfig(config)
        render()
      }
      break
    }
    case 'label-add': {
      // 任意テキストのラベルを作成 (未配置棚に出る)。inline input から読む。
      const input = root?.querySelector<HTMLInputElement>('.lay-add-input')
      const text = (input?.value ?? '').trim().slice(0, 64)
      if (config.glassLayout && text) {
        config.glassLayout.customLabels[genLabelId()] = { text }
        await saveConfig(config)
        render()
      }
      break
    }
    case 'label-delete': {
      // custom ラベルを完全削除 (customLabels から除去 + 全 rows の参照を除去)。
      const id = t.dataset.labelId
      if (config.glassLayout && id) {
        delete config.glassLayout.customLabels[id]
        const k = customLabelKey(id)
        config.glassLayout.rows = config.glassLayout.rows.map((r) => r.filter((x) => x !== k))
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
// change イベントの振り分け: clock フォーマット (Time/Date/順序) → onClockFormatChange、それ以外 → onSegVisChange。
async function onChange(e: Event): Promise<void> {
  const action = (e.target as HTMLElement).dataset.action ?? ''
  if (action.startsWith('clock-')) await onClockFormatChange(e)
  else await onSegVisChange(e)
}

// clock の Time/Date/順序 select 変更を合成して SegCfg.format に保存。
// saveConfig が config-changed を dispatch → glass が loadConfig して実機描画にも反映。
async function onClockFormatChange(e: Event): Promise<void> {
  const t = e.target as HTMLSelectElement
  const key = t.dataset.key
  const segId = t.dataset.seg
  if (!key || !segId) return
  const ref = parseKey(key)
  const sc = config.groups[ref.sourceId]?.[ref.groupId]?.segments.find((s) => s.id === segId)
  if (!sc) return
  const cur = parseClockFormat(sc.format ?? defaultClockFormat())
  if (t.dataset.action === 'clock-time') cur.time = t.value
  else if (t.dataset.action === 'clock-date') cur.date = t.value
  else if (t.dataset.action === 'clock-order') cur.order = t.value === 'date' ? 'date' : 'time'
  sc.format = composeClockFormat(cur.time, cur.date, cur.order) || undefined
  await saveConfig(config)
  render()
}

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

// ── Fullscreen WYSIWYG レイアウトエディタ (実験的) ──
// iOS WKWebView は orientation lock / requestFullscreen が不安定なため、CSS で強制横
// (@media portrait で 90° 回転) する。回転コンテナ内では SortableJS の ghost 座標が壊れる
// ため、D&D は Pointer Events で自前実装する (elementFromPoint で行/ゾーンを判定)。
// 永続データは通常エディタと同じ glassLayout.rows + @right を共有する (新フォーマット無し)。
let fsRoot: HTMLElement | null = null
let fsDrag: { key: string; ghost: HTMLElement } | null = null

// チップの表示文字列 (実機の値。custom ラベルは本文)。
function fsChipText(key: string): string {
  if (isCustomLabelKey(key)) return config.glassLayout?.customLabels[customLabelId(key)]?.text ?? ''
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
  return config.groups[sourceId]?.[groupId]?.showDefaultLabel ?? groupId !== 'clock'
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

// プレビュー本体 (10 行 × 左/右ゾーン) + Unplaced トレイの HTML。
function renderFsBodyHtml(): string {
  const lay = config.glassLayout
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
  // トレイは run の文脈が無いので各チップ単独でグループ名を出す (dedup なし)。
  const trayHtml = tray.length
    ? tray.map((k) => fsChip(k, showsGroupLabel(k), false)).join('')
    : '<span class="fs-empty">Nothing unplaced</span>'
  // .fs-canvas が利用可能領域を埋め、.fs-glass がその中で 2:1 にコンテイン (container query)。
  return `<div class="fs-canvas"><div class="fs-glass">${rows.join('')}</div></div>
    <div class="fs-tray" data-zone="tray"><span class="fs-tray-label">Unplaced</span>${trayHtml}</div>`
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
  const lay = config.glassLayout
  if (!lay) return
  lay.rows = lay.rows.map((r) => {
    const { left, right } = splitRowClusters(r)
    return right.length ? [...left, RIGHT_DIVIDER, ...right] : left
  })
}

function removeFsKey(key: string): void {
  const lay = config.glassLayout
  if (lay) lay.rows = lay.rows.map((r) => r.filter((k) => k !== key))
}

function moveFsKeyToZone(key: string, rowIdx: number, side: 'left' | 'right'): void {
  const lay = config.glassLayout
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
  const target = e.target as HTMLElement
  if (target.closest('.fs-x') || target.closest('.fs-done')) return // 削除/閉じるは click で処理
  const chip = target.closest('.fs-chip') as HTMLElement | null
  const key = chip?.dataset.segkey
  if (!key) return
  e.preventDefault()
  const ghost = chip.cloneNode(true) as HTMLElement
  ghost.classList.add('fs-ghost')
  if (window.matchMedia('(orientation: portrait)').matches) ghost.classList.add('fs-ghost-rot')
  document.body.appendChild(ghost)
  fsDrag = { key, ghost }
  fsPositionGhost(e)
  window.addEventListener('pointermove', onFsPointerMove)
  window.addEventListener('pointerup', onFsPointerUp)
}

function onFsPointerMove(e: PointerEvent): void {
  if (!fsDrag) return
  e.preventDefault()
  fsPositionGhost(e)
  fsClearHot()
  fsZoneAt(e)?.classList.add('fs-hot')
}

function onFsPointerUp(e: PointerEvent): void {
  window.removeEventListener('pointermove', onFsPointerMove)
  window.removeEventListener('pointerup', onFsPointerUp)
  const drag = fsDrag
  fsDrag = null
  drag?.ghost.remove()
  fsClearHot()
  if (!drag || !config.glassLayout) return
  const zone = fsZoneAt(e)
  if (!zone) return
  if (zone.classList.contains('fs-tray')) {
    removeFsKey(drag.key)
    normalizeFsRows()
  } else {
    const row = Number(zone.dataset.row)
    if (!Number.isInteger(row)) return
    moveFsKeyToZone(drag.key, row, zone.dataset.zone === 'right' ? 'right' : 'left')
  }
  void saveConfig(config)
  refreshFsBody()
}

function onFsClick(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
  if (!t) return
  if (t.dataset.action === 'fs-done') {
    closeFsEditor()
    return
  }
  if (t.dataset.action === 'fs-unplace') {
    const key = t.dataset.segkey
    if (key && config.glassLayout) {
      removeFsKey(key)
      normalizeFsRows()
      void saveConfig(config)
      refreshFsBody()
    }
  }
}

function openFsEditor(): void {
  if (fsRoot) return
  fsRoot = document.createElement('div')
  fsRoot.className = 'fs-root'
  fsRoot.innerHTML = renderFsShell()
  document.body.appendChild(fsRoot)
  fsRoot.addEventListener('pointerdown', onFsPointerDown)
  fsRoot.addEventListener('click', onFsClick)
}

function closeFsEditor(): void {
  if (!fsRoot) return
  fsRoot.removeEventListener('pointerdown', onFsPointerDown)
  fsRoot.removeEventListener('click', onFsClick)
  window.removeEventListener('pointermove', onFsPointerMove)
  window.removeEventListener('pointerup', onFsPointerUp)
  fsDrag?.ghost.remove()
  fsDrag = null
  fsRoot.remove()
  fsRoot = null
  render() // 通常画面のプレビューを最新化
}

export async function mountCompanion(el: HTMLElement): Promise<void> {
  root = el
  el.addEventListener('click', (e) => void onClick(e))
  el.addEventListener('change', (e) => void onChange(e)) // segment 条件 / clock フォーマットの select/number
  subscribe(onStoreUpdate)

  config = await loadConfig()
  // 初回 (server ソース無し) は同一オリジンを既定の server として登録 (dev-URL / ブラウザ dev)
  if (ensureDefaultServer(config, location.origin)) await saveConfig(config)
  setSources(config.sources)
  startPolling()
  render() // 時刻 (clock) は glass-local タイマーが所有。companion は周期再描画しない
}

// bridge 接続後: 永続 config を読み直して store に反映する。
export async function onCompanionBridgeReady(): Promise<void> {
  config = await loadConfig()
  if (ensureDefaultServer(config, location.origin)) await saveConfig(config)
  setSources(config.sources)
  render()
}
