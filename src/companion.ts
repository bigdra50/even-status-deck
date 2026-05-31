import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import Sortable from 'sortablejs'
import { localStatus } from './builtins'
import {
  activeProfile,
  activeView,
  addPlace,
  addProfile,
  addServer,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SEG_LABELS,
  BUILTIN_SOURCE_ID,
  type Config,
  customLabelId,
  customLabelKey,
  DEFAULT_PLACE_RADIUS_M,
  DEFAULT_PROFILE_ID,
  duplicateActiveProfile,
  emptyConfig,
  ensureDefaultServer,
  type GlassLayout,
  type GroupRef,
  generateGlassLayout,
  genLabelId,
  isCustomLabelKey,
  isRightDivider,
  isSourceEnabled,
  loadConfig,
  type OptionValues,
  PLACES_SOURCE_ID,
  type Place,
  type Profile,
  RIGHT_DIVIDER,
  reconcileSourceMachine,
  removePlace,
  removeProfile,
  removeSource,
  renamePlace,
  renameProfile,
  type SegMeta,
  type SourceDef,
  saveConfig,
  setActiveProfile,
  setPlaceRadius,
  setProfileGeofence,
  setSourceEnabled,
  sourceById,
  sourceUrl,
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
import {
  type OptionField,
  type OptionScope,
  resolveSegmentOptions,
  resolveSourceOptions,
  segmentOptionSchema,
  setSegmentOption,
  setSourceOption,
  sourceOptionSchema,
} from './options'
import { getCurrentPlaceId } from './places'
import type { Group, Segment, SourceState } from './status-types'
import {
  getAllStatuses,
  getLastSuccessAt,
  getOnlineServerIds,
  getRenderableStatuses,
  getSourceHealth,
  getSourceStatus,
  refreshSourceById,
  setSourcesFromConfig,
  startPolling,
  subscribe,
} from './store'
import { type ProfileSuggestion, suggestProfile, suggestProfileByGeofence } from './suggest'
import { computeVisible, segKey, type VisibilityLeaf } from './visibility'

// 1 segment が持てる条件 leaf の上限 (UI が破綻しない緩い上限)。
const MAX_CONDS = 4

// companion (スマホ WebView) の Home / Source 編集。複数ソースを横断して設定する。
let view: 'home' | 'source-edit' | 'sources' | 'add-source' | 'places' = 'home'
// source-edit から戻る先 (Sources 一覧経由か / Home への新規追加経由か)
let sourceEditBack: 'home' | 'sources' = 'home'
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

// ── Phase 4: プリセット切替の提案 (接続検出ベース。自動適用はしない) ──
// このセッション中に却下した提案 profileId。一度 dismiss した profile は同セッションで再提示しない。
const dismissedSuggestions = new Set<string>()
// 現在表示中の提案 (無ければ null)。store の health 変化で再計算し、変化したときだけ Home を再描画する。
let currentSuggestion: ProfileSuggestion | null = null

// ── デバッグコンソール (実験/検証用) ──
// 実機 (WKWebView) には devtools が無いため、console.* を捕捉して glass preview の下の
// 折りたたみパネルに出す。User/Geo/IP の各プローブで取得可否を実機検証するのに使う。
type DbgLevel = 'log' | 'info' | 'warn' | 'error'
type DbgEntry = { t: number; level: DbgLevel; text: string }
const dbgLogs: DbgEntry[] = []
const DBG_MAX = 500 // 保持する最大行数 (古いものから捨てる)
let dbgOpen = false // 既定は折りたたみ
let dbgFilter = ''
let dbgHooked = false
// User プローブ (bridge.getUserInfo) 用。bridge 接続後に main.ts から注入される。
let probeBridge: EvenAppBridge | null = null

export function setCompanionBridge(b: EvenAppBridge): void {
  probeBridge = b
}

// builtin (clock/g2) は config の format/widthChars を反映した live 値で上書きする
// (store の builtin は config 非依存の既定値なので、プレビュー/Items を選択に追従させる)。
function glassData(): GlassData {
  // glass/preview は offline source を除いた renderable を使う (実機同様に古い値=嘘を出さない)。
  return {
    config,
    statuses: { ...getRenderableStatuses(), [BUILTIN_SOURCE_ID]: localStatus(config) },
  }
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
  const visible = computeVisible(config, getRenderableStatuses())
  const d = glassData()
  const grow = (l: string) => `<span class="grow">${l ? esc(l) : '&nbsp;'}</span>`
  if (activeView(config).glassLayout) {
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
// 実在する (status にある) group だけを active view の groupOrder 順に並べる。
function visibleRefs(): GroupRef[] {
  return activeView(config).groupOrder.filter((r) => statusGroup(r.sourceId, r.groupId))
}

// 表示項目リストの構成シグネチャ (順序込み)。変化したら項目リストを再描画する。
let lastVisibleSig = ''
function visibleSig(): string {
  // group 構成に加え source の鮮度も含める。health 遷移 (online/stale/offline) でも
  // conn-dot と glass preview を再描画するため (offline で preview から group が消える)。
  const refs = visibleRefs()
    .map((r) => `${r.sourceId}:${r.groupId}`)
    .join('|')
  const health = config.sources
    .filter((s) => s.kind === 'server')
    .map((s) => `${s.id}=${getSourceHealth(s.id)}/${worstReportedState(s.id).state}`)
    .join(',')
  return `${refs}#${health}`
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))
}

// inPlace leaf の place select + inside/outside(#43)。
function leafInPlaceParams(a: string, leaf: Extract<VisibilityLeaf, { kind: 'inPlace' }>): string {
  const placeOpts = (config.places ?? [])
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${leaf.placeId === p.id ? 'selected' : ''}>${esc(p.label)}</option>`,
    )
    .join('')
  return `<select class="vis-select" data-action="seg-vis-leaf-place" ${a}>${placeOpts}</select>
    <select class="vis-select" data-action="seg-vis-leaf-side" ${a}>
      <option value="inside" ${leaf.outside ? '' : 'selected'}>inside</option>
      <option value="outside" ${leaf.outside ? 'selected' : ''}>outside</option>
    </select>`
}

// 1 leaf 行 (kind select + params + 削除ボタン)。threshold は percent を持つ segment のみ候補。
// 既存 threshold leaf は percent が無くても候補に残す (data 移行後の編集を壊さない)。inPlace(#43) は保存地点がある時。
function leafRow(seg2: string, leaf: VisibilityLeaf, i: number, hasPct: boolean): string {
  const a = `${seg2} data-idx="${i}"`
  const allowThreshold = hasPct || leaf.kind === 'threshold'
  const allowInPlace = (config.places?.length ?? 0) > 0 || leaf.kind === 'inPlace'
  const kindSel = `<select class="vis-select" data-action="seg-vis-leaf-kind" ${a}>
    ${allowThreshold ? `<option value="threshold" ${leaf.kind === 'threshold' ? 'selected' : ''}>When…</option>` : ''}
    <option value="onChange" ${leaf.kind === 'onChange' ? 'selected' : ''}>On update</option>
    ${allowInPlace ? `<option value="inPlace" ${leaf.kind === 'inPlace' ? 'selected' : ''}>At place</option>` : ''}
  </select>`
  const params =
    leaf.kind === 'threshold'
      ? `<select class="vis-select" data-action="seg-vis-leaf-op" ${a}>
          <option value="gte" ${leaf.op === 'gte' ? 'selected' : ''}>≥</option>
          <option value="lte" ${leaf.op === 'lte' ? 'selected' : ''}>≤</option>
        </select>
        <input class="vis-num" type="number" min="0" max="100" data-action="seg-vis-leaf-value" ${a} value="${leaf.value}" />%`
      : leaf.kind === 'inPlace'
        ? leafInPlaceParams(a, leaf)
        : `<input class="vis-num" type="number" min="1" max="60" data-action="seg-vis-leaf-hold" ${a} value="${Math.round(leaf.holdMs / 1000)}" />s`
  const del = `<button class="vis-del" data-action="seg-vis-remove" ${a} title="Remove" aria-label="Remove">${icon('x', { size: 14 })}</button>`
  return `<div class="vis-cond-row">${kindSel}${params}${del}</div>`
}

// segment 単位の表示タイミング条件エディタ (metric 行のサブ行)。metric は self (その segment 自身)。
// 条件は素材 (SegMeta.visibility。profile 非依存) を読み書きする。
// leaf を AND/OR で複合。conditions 空 = 常時表示。2 件以上で combinator(All of/Any of) を出す。
function segVisEditor(key: string, sm: SegMeta, seg: Segment): string {
  const seg2 = `data-key="${key}" data-seg="${esc(sm.id)}"`
  const hasPct = typeof seg.percent === 'number'
  const conditions = sm.visibility?.conditions ?? []
  const combinator = sm.visibility?.combinator ?? 'and'
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

// 表示オプションの汎用レンダラ (#36)。schema (OptionField[]) を select / toggle / number で描く。
// scope で segment/source を区別し、segId は segment scope のときのみ意味を持つ (source は空)。
// select / number は change イベント (onOptionChange)、toggle は click イベント (onClick の opt-set) で届く。
// clock の Time/Date/順序 もこのレンダラで描かれ、値解決/書込は options.ts が format に合成する。
function optionControls(
  key: string,
  segId: string,
  scope: OptionScope,
  fields: OptionField[],
  values: OptionValues,
): string {
  if (!fields.length) return ''
  const a = `data-action="opt-set" data-key="${key}" data-seg="${esc(segId)}" data-scope="${scope}"`
  const ctl = (f: OptionField): string => {
    if (f.kind === 'select') {
      const cur = String(values[f.id] ?? f.default)
      const opts = f.choices
        .map(
          (c) =>
            `<option value="${esc(c.value)}" ${c.value === cur ? 'selected' : ''}>${esc(c.label)}</option>`,
        )
        .join('')
      return `<label class="clock-fld">${esc(f.label)}<select class="format-select" ${a} data-field="${esc(f.id)}" data-kind="select">${opts}</select></label>`
    }
    if (f.kind === 'toggle') {
      const raw = values[f.id]
      const on = typeof raw === 'boolean' ? raw : f.default
      return `<label class="clock-fld">${esc(f.label)}<button class="tg sm ${on ? 'on' : ''}" ${a} data-field="${esc(f.id)}" data-kind="toggle" data-val="${on ? '0' : '1'}"></button></label>`
    }
    const cur = Number(values[f.id] ?? f.default)
    const step = f.step ? `step="${f.step}"` : ''
    return `<label class="clock-fld">${esc(f.label)}<input class="vis-num" type="number" min="${f.min}" max="${f.max}" ${step} ${a} data-field="${esc(f.id)}" data-kind="number" value="${cur}" />${f.unit ? esc(f.unit) : ''}</label>`
  }
  return `<div class="clock-ctl">${fields.map(ctl).join('')}</div>`
}

function groupRow(ref: GroupRef): string {
  const g = statusGroup(ref.sourceId, ref.groupId)
  const meta = config.groups[ref.sourceId]?.[ref.groupId]
  const vg = activeView(config).groups[ref.sourceId]?.[ref.groupId]
  if (!g || !meta || !vg) return ''
  const src = sourceById(config, ref.sourceId)
  const isBuiltin = ref.sourceId === BUILTIN_SOURCE_ID
  const key = `${esc(ref.sourceId)}|${esc(ref.groupId)}`
  // builtin の行名はコード所有ラベル (BUILTIN_GROUP_LABELS) を使い、永続 source label に依存しない。
  const title = isBuiltin
    ? (BUILTIN_GROUP_LABELS[ref.groupId] ?? ref.groupId)
    : g.label || src?.label || ref.groupId
  const caret = icon(vg.expanded ? 'chevron-down' : 'chevron-right', { size: 16 })
  const segById = new Map(g.segments.map((s) => [s.id, s]))
  // segment の並びは素材 (meta.segments)、ON/OFF・条件は view/素材から引く。
  // source 単位の表示オプション (#36)。素材 = 全 profile 共有。スキーマが空なら描かない。
  // srcOpts は .src-metrics の「外」(直前) に出す。.src-metrics は SortableJS の segment 並べ替え
  // コンテナで、onSegReorder が e.oldIndex(= 全直接子の index) を meta.segments index として使うため、
  // 非 segment ノードを中に混ぜると index が +1 ずれて別 segment を動かす (silent なデータ破損)。
  const srcFields = sourceOptionSchema(ref.sourceId)
  const srcOpts = srcFields.length
    ? optionControls(key, '', 'source', srcFields, resolveSourceOptions(config, ref.sourceId))
    : ''
  const metrics = vg.expanded
    ? `${srcOpts}<div class="src-metrics" data-key="${key}">${meta.segments
        .map((sm) => {
          const seg = segById.get(sm.id)
          if (!seg) return ''
          const enabled = vg.segments[sm.id] ?? true
          // segment 単位の表示オプション (#36)。clock の Time/Date/順序 もこの schema 経由で描く。
          const segFields = segmentOptionSchema(ref.sourceId, ref.groupId, sm.id)
          const segOpts = segFields.length
            ? optionControls(
                key,
                sm.id,
                'segment',
                segFields,
                resolveSegmentOptions(config, ref.sourceId, ref.groupId, sm.id),
              )
            : ''
          return `<div class="metric"><div class="metric-row"><span class="mgrip">${icon('grip', { size: 16 })}</span>
              <span class="mname">${esc(isBuiltin ? (BUILTIN_SEG_LABELS[seg.id] ?? seg.id) : seg.label || seg.id)}</span>
              <span class="mval">${esc(seg.value)}</span>
              <button class="tg sm ${enabled ? 'on' : ''}" data-action="toggle-seg" data-key="${key}" data-seg="${esc(sm.id)}"></button></div>
            ${segOpts}
            ${segVisEditor(key, sm, seg)}</div>`
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
  const showsLabel = vg.showDefaultLabel ?? ref.groupId !== 'clock'
  const labelBtn = `<button class="label-btn ${showsLabel ? 'on' : ''}" data-action="toggle-grouplabel" data-key="${key}" title="${showsLabel ? 'Group label shown on glass' : 'Group label hidden'}">${icon('tag', { size: 15 })}</button>`
  return `<div class="src" data-key="${key}"><div class="src-head"><span class="src-grip">${icon('grip', { size: 16 })}</span>
    <span class="src-caret" data-action="expand" data-key="${key}">${caret}</span>
    <span class="src-name" data-action="expand" data-key="${key}">${esc(title)}</span>
    ${srcTag}
    ${labelBtn}
    <button class="tg ${vg.enabled ? 'on' : ''}" data-action="toggle-group" data-key="${key}"></button></div>${metrics}</div>`
}

function renderItems(): string {
  return visibleRefs()
    .map((r) => groupRow(r))
    .join('')
}

// ── source 行 (3 文脈: Home=preset 内 / Sources 一覧 / preset へ追加) ──
// ソースが報告する最悪状態 (PROTOCOL §3, transport 鮮度とは別軸)。segment.state は group.state を上書き。
const STATE_RANK: Record<SourceState, number> = { ok: 0, stale: 1, error: 2 }
function worstReportedState(sourceId: string): { state: SourceState; message?: string } {
  const doc = getSourceStatus(sourceId)
  let worst: SourceState = 'ok'
  let message: string | undefined
  for (const g of doc?.groups ?? []) {
    const gs = g.state ?? 'ok'
    if (STATE_RANK[gs] > STATE_RANK[worst]) {
      worst = gs
      message = g.message
    }
    for (const seg of g.segments) {
      const ss = seg.state ?? g.state ?? 'ok'
      if (STATE_RANK[ss] > STATE_RANK[worst]) {
        worst = ss
        message = seg.message ?? g.message
      }
    }
  }
  return { state: worst, message }
}

// 接続状態 dot と note (online=緑 / stale=琥珀 / offline=灰+"Last seen…")。
// transport が online でもソースが degraded を報告していれば琥珀 + message を出す (2 軸)。
function sourceDotNote(s: SourceDef): { dotCls: string; note: string } {
  const health = getSourceHealth(s.id)
  // client (weather): URL は無く現在地ベース。health と reported state で位置の note を出す。
  if (s.kind === 'client') {
    if (health === 'offline') return { dotCls: 'off', note: 'Uses device location' }
    const reported = worstReportedState(s.id)
    if (reported.state === 'error') {
      return { dotCls: 'off', note: reported.message ?? 'Location unavailable' }
    }
    if (reported.state === 'stale' || health === 'stale') {
      return { dotCls: 'stale', note: 'Cached weather' }
    }
    return { dotCls: '', note: 'Device location' }
  }
  if (health === 'offline') return { dotCls: 'off', note: lastSeenText(s.id) }
  if (health === 'online') {
    const reported = worstReportedState(s.id)
    if (reported.state !== 'ok') {
      return { dotCls: 'stale', note: reported.message ?? `Source ${reported.state}` }
    }
  }
  const dotCls = health === 'stale' ? 'stale' : ''
  return { dotCls, note: sourceUrl(s) ?? 'Not set' }
}

// Home: この preset に追加済みの source。preset から外す操作のみ (非破壊)。編集は Sources 一覧へ。
function sourcePresetRow(s: SourceDef): string {
  const { dotCls, note } = sourceDotNote(s)
  return `<div class="src"><div class="src-head"><span class="conn-dot ${dotCls}"></span>
    <span class="src-name">${esc(s.label)}</span>
    <span class="src-note">${esc(note)}</span>
    <button class="link-btn" data-action="remove-from-preset" data-src="${esc(s.id)}" title="Remove from this preset">Remove</button></div></div>`
}

// Sources 一覧: 全 source 実体の管理。編集 (URL/machineId/削除) へ。
function sourceManageRow(s: SourceDef): string {
  const { dotCls, note } = sourceDotNote(s)
  return `<div class="src"><div class="src-head"><span class="conn-dot ${dotCls}"></span>
    <span class="src-name">${esc(s.label)}</span>
    <span class="src-note">${esc(note)}</span>
    <button class="gear-btn" data-action="edit-source" data-src="${esc(s.id)}" title="Edit" aria-label="Edit">${icon('settings', { size: 18 })}</button></div></div>`
}

// preset への追加候補: まだこの preset に無い source。タップで preset へ追加。
function sourceAddRow(s: SourceDef): string {
  const { dotCls, note } = sourceDotNote(s)
  return `<div class="src"><div class="src-head"><span class="conn-dot ${dotCls}"></span>
    <span class="src-name">${esc(s.label)}</span>
    <span class="src-note">${esc(note)}</span>
    <button class="link-btn" data-action="add-to-preset" data-src="${esc(s.id)}" title="Add to this preset">Add</button></div></div>`
}

// offline source の最終接続時刻を相対表記する ("Last seen 3m ago")。未接続は "Not connected"。
function lastSeenText(id: string): string {
  const at = getLastSuccessAt(id)
  if (at == null) return 'Not connected'
  const m = Math.floor((Date.now() - at) / 60_000)
  if (m < 1) return 'Last seen just now'
  if (m < 60) return `Last seen ${m}m ago`
  return `Last seen ${Math.floor(m / 60)}h ago`
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

// 配置可能な全 key (active view の groupOrder 順)。未配置リストの母集合。
// group ラベルは default-label (group 単位トグル) が自動で出すので chip にはしない。
function allPlaceableKeys(): string[] {
  const view = activeView(config)
  const keys: string[] = []
  for (const ref of view.groupOrder) {
    const meta = config.groups[ref.sourceId]?.[ref.groupId]
    const vg = view.groups[ref.sourceId]?.[ref.groupId]
    if (!meta || !vg) continue
    for (const sm of meta.segments) {
      if (vg.segments[sm.id] ?? true) keys.push(segKey(ref.sourceId, ref.groupId, sm.id))
    }
  }
  // ユーザー定義の custom ラベル
  for (const id of Object.keys(view.glassLayout?.customLabels ?? {})) keys.push(customLabelKey(id))
  return keys
}

// 行 (key 配列) が glass 1 行 (等幅近似で ~50 桁) に収まらなさそうか。
// segment は widthChars (確保枠) 優先、無ければ value 長。custom ラベルはテキスト長。
// group default-label の前置分も run 先頭で加算 (rowText の dedup と合わせる)。
const ROW_MAX_CHARS = 50
function rowOverflow(items: string[]): boolean {
  const view = activeView(config)
  let total = 0
  let n = 0
  let prevGroup: string | null = null
  for (const key of items) {
    if (isCustomLabelKey(key)) {
      const text = view.glassLayout?.customLabels[customLabelId(key)]?.text ?? ''
      if (!text) continue
      total += text.length
      prevGroup = null
      n++
      continue
    }
    const [sourceId, groupId, segId] = key.split('|')
    const seg = statusGroup(sourceId, groupId)?.segments.find((s) => s.id === segId)
    if (!seg) continue
    const vg = view.groups[sourceId]?.[groupId]
    const inMeta = config.groups[sourceId]?.[groupId]?.segments.some((s) => s.id === segId) ?? false
    // 無効化された segment は glass(rowText) で描画されないので幅計算からも除外 (過大評価防止)。
    if (!inMeta || !(vg?.segments[segId] ?? true)) continue
    const labelLen = seg.label ? seg.label.length + 1 : 0
    const valLen = seg.widthChars ?? seg.value.length
    let w = labelLen + valLen
    const showsLabel = vg?.showDefaultLabel ?? groupId !== 'clock'
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
    const text = activeView(config).glassLayout?.customLabels[id]?.text ?? ''
    const del = `<button class="wys-x" data-action="label-delete" data-label-id="${esc(id)}" title="Delete label" aria-label="Delete label">${icon('x', { size: 10 })}</button>`
    return `<span class="wys-chip wys-label-chip wys-custom-chip" data-segkey="${esc(key)}" title="${esc(text)}">${grip}<span class="wys-txt">${esc(text)}</span>${del}</span>`
  }
  const [sourceId, groupId, segId] = key.split('|')
  const { group, seg } = segLabelParts(key)
  const x = `<button class="wys-x" data-action="layout-item-remove" data-segkey="${esc(key)}" aria-label="Unplace">${icon('x', { size: 10 })}</button>`
  const sg = statusGroup(sourceId, groupId)?.segments.find((s) => s.id === segId)
  const text = sg ? (sg.label ? `${sg.label} ${sg.value}` : sg.value) : seg
  // default-label ON の group のみ group 名を薄く前置表示 (実機の前置ラベルに対応)
  const vg = activeView(config).groups[sourceId]?.[groupId]
  const showsLabel = vg?.showDefaultLabel ?? groupId !== 'clock'
  const grp = group && showsLabel ? `<span class="wys-grp">${esc(group)}</span>` : ''
  return `<span class="wys-chip" data-segkey="${esc(key)}" title="${esc(group ? `${group} ${seg}` : seg)}">${grip}${grp}<span class="wys-txt">${esc(text)}</span>${x}</span>`
}

// 編集モードのキャンバス: 固定 MAX_ROWS 行 (行番号ガター + 左/右ゾーン) + 未配置棚 + Reset。
// 行番号 = glass の上からの絶対位置。glass にヒント行は出さないので予約行も無い (全行配置可)。
// 各行は左ゾーン｜右ゾーンの 2 ドロップ領域。右ゾーンに置いた chip は実機で右寄せされる。
function renderGlassEdit(lay: GlassLayout): string {
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
  const lay = activeView(config).glassLayout
  if (!lay) {
    return `<div class="cmp-label cmp-label-row">Glass<span class="cmp-actions">
        <button class="gear-btn" data-action="layout-customize" title="Customize layout" aria-label="Customize layout">${icon('layout', { size: 16 })}</button>
        <button class="gear-btn" data-action="fs-open" title="Fullscreen edit (beta)" aria-label="Fullscreen edit">${icon('maximize', { size: 16 })}</button>
      </span></div>
      <div class="gpv"><div class="gpv-cap">G2 576×288</div><div class="gpv-screen">${glassPreviewHtml()}</div></div>
      <div class="cmp-sub">Glass gestures: tap = summary / swipe = switch view / double-tap = exit</div>
      <div class="cmp-sub">One row per group. Customize layout to place items freely on the preview.</div>`
  }
  if (layoutEditing) {
    return `<div class="cmp-label cmp-label-row">Glass layout<button class="gear-btn" data-action="layout-edit-toggle" title="Done" aria-label="Done">${icon('check', { size: 16 })}</button></div>
      <div class="cmp-sub">Drag items to rows (1–${MAX_ROWS}) or the Unplaced shelf. Row number = position from top of glass.</div>
      ${renderGlassEdit(lay)}`
  }
  return `<div class="cmp-label cmp-label-row">Glass<span class="cmp-actions"><button class="gear-btn" data-action="layout-edit-toggle" title="Edit layout" aria-label="Edit layout">${icon('layout', { size: 16 })}</button><button class="gear-btn" data-action="fs-open" title="Fullscreen edit" aria-label="Fullscreen edit">${icon('maximize', { size: 16 })}</button></span></div>
    <div class="gpv"><div class="gpv-cap">G2 576×288</div><div class="gpv-screen">${glassPreviewHtml()}</div></div>
    <div class="cmp-sub">Glass gestures: tap = summary / swipe = switch view / double-tap = exit</div>`
}

// ── Phase 4: プリセット切替の提案 (バナー) ──
// オンラインな server source 集合から最適 profile を求める純粋関数 (suggestProfile) を呼び、
// このセッションで却下済み (dismissedSuggestions) の提案は除外する。currentSuggestion を更新し、
// 提示すべき内容が変わったか (profileId の差分) を返す (変化時のみ Home を再描画するため)。
function recomputeSuggestion(): boolean {
  // ジオフェンス(#43)を優先(現在地は強いシグナル)。圏内に suggest モードの bound preset があればそれ、
  // 無ければ従来の接続ベース提案にフォールバックする。
  const next =
    suggestProfileByGeofence(config, getCurrentPlaceId()) ??
    suggestProfile(config, getOnlineServerIds())
  const shown = next && !dismissedSuggestions.has(next.profileId) ? next : null
  const changed = (currentSuggestion?.profileId ?? null) !== (shown?.profileId ?? null)
  currentSuggestion = shown
  return changed
}

// #43 ジオフェンス自動切替: 新しい place に入ったら mode=auto の bound preset へ 1 回切替える。
// 同じ place に留まっている間は何もしない(flapping/手動操作の上書き防止)。圏外/位置不明なら何もしない。
let lastGeofencePlace: string | null = null
function maybeGeofenceAutoSwitch(): void {
  const placeId = getCurrentPlaceId()
  if (placeId === lastGeofencePlace) return // place 不変 = 何もしない
  lastGeofencePlace = placeId
  if (!placeId) return
  const prof = config.profiles.find(
    (p) => p.geofence?.placeId === placeId && p.geofence?.mode === 'auto',
  )
  if (!prof || prof.id === config.activeProfileId) return
  setActiveProfile(config, prof.id)
  applyProfileChange() // saveConfig + syncAll + setSourcesFromConfig + render
}

// 提案バナー: 非モーダルで dismiss 可能 (Switch / × の 2 アクション)。glass は勝手に変えない。
// 提案が無ければ空文字 (Home から消える)。承認で Phase 2 の切替 (onSuggestAccept) を呼ぶ。
function renderSuggestionBanner(): string {
  const s = currentSuggestion
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
  const active = activeProfile(config)
  const options = config.profiles
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${p.id === active.id ? 'selected' : ''}>${esc(p.name)}</option>`,
    )
    .join('')
  // Default は削除不可 + profile が 1 個だけのときも削除不可 (最後の 1 個は残す)。
  const canDelete = active.id !== DEFAULT_PROFILE_ID && config.profiles.length > 1
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
// place=Off で解除、suggest=バナー提案 / auto=圏内で自動切替。Places source の位置を使う。
function renderProfileGeofence(active: Profile): string {
  const places = config.places ?? []
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
  // この preset に追加済みの server source だけ表示 (builtin は Items の Clock/G2 に出る)。
  const sources = config.sources.filter(
    (s) => s.kind !== 'builtin' && isSourceEnabled(config, s.id),
  )
  const sourcesHtml = sources.length
    ? sources.map(sourcePresetRow).join('')
    : '<div class="cmp-sub">No sources in this preset.</div>'
  return `
    ${renderSuggestionBanner()}
    ${renderProfileBar()}

    <div class="cmp-label cmp-label-row">Sources<span class="cmp-actions"><button class="link-btn" data-action="manage-sources">Manage all</button></span></div>
    ${sourcesHtml}
    <button class="save-btn sm" data-action="open-add-source">${icon('plus', { size: 14 })} Add source</button>

    <div class="cmp-label cmp-label-row">Places<span class="cmp-actions"><button class="link-btn" data-action="manage-places">Manage</button></span></div>
    <div class="cmp-sub">Saved spots for the Places source (distance &amp; bearing from here).</div>

    <div class="cmp-label">Items (drag ${icon('grip', { size: 12 })} to reorder)</div>
    <div id="source-list">${renderItems()}</div>

    ${renderGlassSection()}

    ${renderDbgConsole()}
  `
}

// Sources 一覧: 全 source 実体 (preset 非依存)。編集・削除はここに集約。
function renderSources(): string {
  // Manage all は URL を持つ server source のみ (client=weather は Home の Add/Remove で管理)。
  const sources = config.sources.filter((s) => s.kind === 'server')
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
  const available = config.sources.filter(
    (s) => s.kind !== 'builtin' && !isSourceEnabled(config, s.id),
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

// ── 保存地点管理 (#42) ──
// 各保存地点を name + 座標 + 削除で並べ、現在地を新規保存できる。地点ナビ(Places source)が
// ここの保存地点までの距離・方位を出す。
function placeManageRow(p: Place): string {
  const radius = p.radiusM ?? DEFAULT_PLACE_RADIUS_M
  return `<div class="src"><div class="src-head">
    <span class="src-name">${esc(p.label)}</span>
    <span class="src-note mono">${p.lat.toFixed(3)}, ${p.lon.toFixed(3)} · ${radius}m</span>
    <button class="link-btn" data-action="rename-place" data-place="${esc(p.id)}" title="Rename">Rename</button>
    <button class="link-btn" data-action="radius-place" data-place="${esc(p.id)}" title="Geofence radius">Radius</button>
    <button class="link-btn" data-action="delete-place" data-place="${esc(p.id)}" title="Delete">Delete</button></div></div>`
}

function renderPlaces(): string {
  const places = config.places ?? []
  const html = places.length
    ? places.map(placeManageRow).join('')
    : '<div class="cmp-sub">No saved places yet. Save your current location to start.</div>'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">${icon('arrow-left', { size: 16 })} Home</button>
      <span class="h-title">Places</span><span></span></div>
    <div class="cmp-sub">Distance and bearing to these spots show under the Places source (enable it in Add source).</div>
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

// 保存地点変更後の共通処理: 永続化 → store へ反映(setSavedPlaces 経由) → 地点ナビ再計算 → 再描画。
function afterPlacesChange(): void {
  void saveConfig(config)
  setSourcesFromConfig(config) // store の savedPlaces を最新化(Places source が有効なら再 fetch 範囲も同期)
  refreshSourceById(PLACES_SOURCE_ID) // 現在地から距離・方位を再計算
  render()
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
  const url = testUrl || (s ? sourceUrl(s) : undefined) || 'http://127.0.0.1:8723'
  const testing = testState === 'testing'
  const backLabel = sourceEditBack === 'sources' ? 'Sources' : 'Home'
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
    <button class="danger-btn" data-action="delete-source">Delete source (all presets)</button>
  `
}

function render(): void {
  if (!root) return
  // Home を出す直前に提案を最新化する。store の health 変化は Home 以外 (source-edit) でも
  // 起こり得る (接続テストで追加した source が即 offline になる等) が、その間の notify は
  // onStoreUpdate が握り潰すため、Home へ戻った描画時に必ず計算し直してバナーを正す。
  if (view === 'home') recomputeSuggestion()
  root.innerHTML =
    view === 'source-edit'
      ? renderSourceEdit()
      : view === 'sources'
        ? renderSources()
        : view === 'add-source'
          ? renderAddSource()
          : view === 'places'
            ? renderPlaces()
            : renderHome()
  if (view === 'home') {
    lastVisibleSig = visibleSig()
    attachSortables()
    if (dbgOpen) scrollDbgBottom() // 開いていれば最新行へ
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
  const view = activeView(config)
  if (!view.glassLayout) return
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
  view.glassLayout = { rows, customLabels: view.glassLayout.customLabels }
  void saveConfig(config)
  render()
}

function parseKey(key: string): GroupRef {
  const [sourceId, groupId] = key.split('|')
  return { sourceId: sourceId ?? '', groupId: groupId ?? '' }
}

// active view の groupOrder を並べ替える。indices は visibleRefs (実在 group) 基準。非表示 ref は温存。
function onGroupReorder(oldIndex?: number, newIndex?: number): void {
  if (oldIndex == null || newIndex == null || oldIndex === newIndex) return
  const view = activeView(config)
  const visible = visibleRefs()
  const [moved] = visible.splice(oldIndex, 1)
  if (!moved) return
  visible.splice(newIndex, 0, moved)
  const rest = view.groupOrder.filter((r) => !statusGroup(r.sourceId, r.groupId))
  view.groupOrder = [...visible, ...rest]
  void saveConfig(config)
  updatePreview()
}

// segment の並び順は素材 (GroupMeta.segments) に持つ (全 profile 共通の順序基準)。
function onSegReorder(key: string, oldIndex?: number, newIndex?: number): void {
  const ref = parseKey(key)
  const meta = config.groups[ref.sourceId]?.[ref.groupId]
  if (!meta || oldIndex == null || newIndex == null || oldIndex === newIndex) return
  const [moved] = meta.segments.splice(oldIndex, 1)
  if (!moved) return
  meta.segments.splice(newIndex, 0, moved)
  void saveConfig(config)
  updatePreview()
}

// profile を切替/複製/追加した後の共通処理。enabledSourceIds が変わるので store の fetch 範囲を
// 更新し (setSourcesFromConfig)、glass へは saveConfig の config-changed が view 差し替えを伝える。
// layoutEditing は profile を跨ぐと配置が混乱するため必ず解除する。
// syncAll: 切替先 (新規/複製先) の view が空でも、既に取得済みの status から group/segment 枠を
//   補充する (setSourcesFromConfig は未変更ソースを再 fetch しない = onStoreUpdate が来ないため、
//   ここで明示的に active view へ反映してから描画する)。
function applyProfileChange(): void {
  layoutEditing = false
  void saveConfig(config)
  syncAll() // 切替先 view を cached status から補充 (変化あれば内部で保存)
  setSourcesFromConfig(config)
  render() // render() が Home 描画前に recomputeSuggestion する (active 変更で提案が変わる)
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
    case 'suggest-accept':
      onSuggestAccept()
      break
    case 'suggest-dismiss':
      // このセッション中は同じ提案 (同 profile) を再表示しない。glass はそのまま (手動操作を妨げない)。
      if (currentSuggestion) dismissedSuggestions.add(currentSuggestion.profileId)
      currentSuggestion = null
      render()
      break
    case 'profile-add':
      addProfile(config, `Preset ${config.profiles.length + 1}`)
      applyProfileChange()
      break
    case 'profile-duplicate':
      duplicateActiveProfile(config)
      applyProfileChange()
      break
    case 'profile-rename': {
      const cur = activeProfile(config)
      const name = window.prompt('Preset name', cur.name)
      if (name?.trim()) {
        renameProfile(config, cur.id, name)
        void saveConfig(config)
        render()
      }
      break
    }
    case 'profile-delete': {
      const cur = activeProfile(config)
      if (cur.id === DEFAULT_PROFILE_ID || config.profiles.length <= 1) break
      if (!window.confirm(`Delete preset "${cur.name}"?`)) break
      if (removeProfile(config, cur.id)) applyProfileChange()
      break
    }
    case 'manage-sources':
      view = 'sources'
      render()
      break
    case 'manage-places':
      view = 'places'
      render()
      break
    case 'add-current-place': {
      // 現在地を取得して名前を付けて保存する。位置許可が無ければ案内して中断。
      const name = window.prompt('Place name', 'Home')
      if (!name?.trim()) break
      try {
        const pos = await getCompanionPosition()
        addPlace(config, name.trim(), pos.lat, pos.lon)
        afterPlacesChange()
      } catch {
        window.alert('Could not get your location. Allow location access and try again.')
      }
      break
    }
    case 'rename-place': {
      const id = t.dataset.place
      const p = config.places?.find((x) => x.id === id)
      if (!id || !p) break
      const name = window.prompt('Place name', p.label)
      if (name?.trim() && renamePlace(config, id, name.trim())) afterPlacesChange()
      break
    }
    case 'radius-place': {
      // ジオフェンス半径(m)。inPlace 表示条件と here(現在地)判定の圏を決める(#43)。
      const id = t.dataset.place
      const p = config.places?.find((x) => x.id === id)
      if (!id || !p) break
      const cur = String(p.radiusM ?? DEFAULT_PLACE_RADIUS_M)
      const input = window.prompt('Geofence radius (meters)', cur)
      const m = input == null ? Number.NaN : Number(input)
      if (Number.isFinite(m) && setPlaceRadius(config, id, m)) afterPlacesChange()
      break
    }
    case 'delete-place': {
      const id = t.dataset.place
      if (!id) break
      const p = config.places?.find((x) => x.id === id)
      if (p && window.confirm(`Delete "${p.label}"?`) && removePlace(config, id))
        afterPlacesChange()
      break
    }
    case 'open-add-source':
      view = 'add-source'
      render()
      break
    case 'add-to-preset': {
      // 既存 source をこの preset に追加する。
      const id = t.dataset.src
      if (id) {
        setSourceEnabled(config, id, true)
        void saveConfig(config)
        setSourcesFromConfig(config) // fetch 範囲を広げる (取得開始)
        view = 'home'
        render()
      }
      break
    }
    case 'remove-from-preset': {
      // この preset から外す (非破壊)。実体は残り、Items/glass からは消える。
      const id = t.dataset.src
      if (id) {
        setSourceEnabled(config, id, false)
        void saveConfig(config)
        setSourcesFromConfig(config) // fetch 範囲を狭める (停止/status 破棄)
        render()
      }
      break
    }
    case 'create-new-source': {
      // preset への新規追加: 実体を作り active preset に入れて URL 入力へ。戻り先は Home。
      const def = addServer(config, 'New server')
      void saveConfig(config)
      editingSourceId = def.id
      testState = 'idle'
      testUrl = ''
      editMachine = null
      sourceEditBack = 'home'
      view = 'source-edit'
      render()
      break
    }
    case 'new-source': {
      // Sources 一覧からの新規 (実体追加)。戻り先は Sources 一覧。
      const def = addServer(config, 'New server')
      void saveConfig(config)
      editingSourceId = def.id
      testState = 'idle'
      testUrl = ''
      editMachine = null
      sourceEditBack = 'sources'
      view = 'source-edit'
      render()
      break
    }
    case 'edit-source':
      editingSourceId = t.dataset.src ?? null
      testState = 'idle'
      testUrl = ''
      editMachine = null
      sourceEditBack = 'sources'
      view = 'source-edit'
      render()
      break
    case 'back':
      editingSourceId = null
      view = sourceEditBack
      render()
      break
    case 'delete-source':
      if (editingSourceId) {
        removeSource(config, editingSourceId)
        void saveConfig(config)
        setSourcesFromConfig(config)
        editingSourceId = null
        view = sourceEditBack
        render()
      }
      break
    case 'expand': {
      const ref = parseKey(t.dataset.key ?? '')
      const vg = activeView(config).groups[ref.sourceId]?.[ref.groupId]
      if (vg) {
        vg.expanded = !vg.expanded
        void saveConfig(config)
        render()
      }
      break
    }
    case 'toggle-group': {
      const ref = parseKey(t.dataset.key ?? '')
      const vg = activeView(config).groups[ref.sourceId]?.[ref.groupId]
      if (vg) {
        vg.enabled = !vg.enabled
        void saveConfig(config)
        render()
      }
      break
    }
    case 'toggle-grouplabel': {
      // glass で group 名を前置するか (default-label)。
      const ref = parseKey(t.dataset.key ?? '')
      const vg = activeView(config).groups[ref.sourceId]?.[ref.groupId]
      if (vg) {
        vg.showDefaultLabel = !(vg.showDefaultLabel ?? ref.groupId !== 'clock')
        void saveConfig(config)
        render()
      }
      break
    }
    case 'toggle-seg': {
      const ref = parseKey(t.dataset.key ?? '')
      const vg = activeView(config).groups[ref.sourceId]?.[ref.groupId]
      const segId = t.dataset.seg
      if (vg && segId) {
        vg.segments[segId] = !(vg.segments[segId] ?? true)
        void saveConfig(config)
        render()
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
      const sm = config.groups[ref.sourceId]?.[ref.groupId]?.segments.find(
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
          void saveConfig(config)
          render()
        }
      }
      break
    }
    case 'seg-vis-remove': {
      const ref = parseKey(t.dataset.key ?? '')
      const sm = config.groups[ref.sourceId]?.[ref.groupId]?.segments.find(
        (s) => s.id === t.dataset.seg,
      )
      const idx = Number(t.dataset.idx)
      if (sm?.visibility && Number.isInteger(idx)) {
        sm.visibility.conditions.splice(idx, 1)
        if (sm.visibility.conditions.length === 0) sm.visibility = undefined
        void saveConfig(config)
        render()
      }
      break
    }
    case 'layout-edit-toggle':
      layoutEditing = !layoutEditing
      render()
      break
    case 'layout-customize':
      activeView(config).glassLayout = generateGlassLayout(config)
      layoutEditing = true // 生成と同時に編集モードへ
      void saveConfig(config)
      render()
      break
    case 'layout-reset':
      activeView(config).glassLayout = undefined
      layoutEditing = false
      void saveConfig(config)
      render()
      break
    case 'fs-open': {
      // フルスクリーン WYSIWYG エディタ (実験的)。custom layout 未生成なら生成して開く。
      const view = activeView(config)
      if (!view.glassLayout) {
        view.glassLayout = generateGlassLayout(config)
        void saveConfig(config)
      }
      openFsEditor()
      break
    }
    case 'layout-item-remove': {
      // segment を全行から外す → 未配置 (Unplaced 棚) に導出される。
      const key = t.dataset.segkey
      const lay = activeView(config).glassLayout
      if (lay && key) {
        lay.rows = lay.rows.map((r) => r.filter((k) => k !== key))
        void saveConfig(config)
        render()
      }
      break
    }
    case 'label-add': {
      // 任意テキストのラベルを作成 (未配置棚に出る)。inline input から読む。
      const input = root?.querySelector<HTMLInputElement>('.lay-add-input')
      const text = (input?.value ?? '').trim().slice(0, 64)
      const lay = activeView(config).glassLayout
      if (lay && text) {
        lay.customLabels[genLabelId()] = { text }
        void saveConfig(config)
        render()
      }
      break
    }
    case 'label-delete': {
      // custom ラベルを完全削除 (customLabels から除去 + 全 rows の参照を除去)。
      const id = t.dataset.labelId
      const lay = activeView(config).glassLayout
      if (lay && id) {
        delete lay.customLabels[id]
        const k = customLabelKey(id)
        lay.rows = lay.rows.map((r) => r.filter((x) => x !== k))
        void saveConfig(config)
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
    case 'console-toggle':
      dbgOpen = !dbgOpen
      render()
      break
    case 'console-copy':
      await copyDbgLogs(t)
      break
    case 'console-clear':
      dbgLogs.length = 0
      updateDbgListDom()
      updateDbgCount()
      break
    case 'probe-userinfo':
      await probeUserInfo()
      break
    case 'probe-geo':
      probeGeo()
      break
    case 'probe-ip':
      await probeIp()
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
  else onSegVisChange(e)
}

// #43 active preset のジオフェンス連動(place + mode)を保存する。place/mode の両 select を読む。
function onGeofenceBindChange(): void {
  const active = activeProfile(config)
  const placeSel = root?.querySelector<HTMLSelectElement>('[data-action="profile-geofence-place"]')
  const modeSel = root?.querySelector<HTMLSelectElement>('[data-action="profile-geofence-mode"]')
  const placeId = placeSel?.value || null
  const mode = modeSel?.value === 'auto' ? 'auto' : 'suggest'
  if (setProfileGeofence(config, active.id, placeId, mode)) {
    lastGeofencePlace = null // バインド変更後は次の onStoreUpdate で auto 切替を再評価させる
    void saveConfig(config)
    render()
  }
}

// Preset select の変更で active profile を切替える。enabledSourceIds が変わるため
// fetch 範囲も更新する (applyProfileChange)。
function onProfileSwitch(e: Event): void {
  const id = (e.target as HTMLSelectElement).value
  if (!id || id === config.activeProfileId) return
  setActiveProfile(config, id)
  applyProfileChange()
}

// 提案バナーの承認: Phase 2 の切替を呼ぶ (自動適用ではなくユーザー操作を起点にする)。
// 提案先が存在しなければ何もしない (取り違え防止)。切替後は applyProfileChange が提案を再計算する。
function onSuggestAccept(): void {
  const s = currentSuggestion
  if (!s || s.profileId === config.activeProfileId) return
  if (!config.profiles.some((p) => p.id === s.profileId)) return
  setActiveProfile(config, s.profileId)
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
    ok = setSegmentOption(config, ref.sourceId, ref.groupId, segId, fieldId, rawValue)
  } else {
    ok = setSourceOption(config, ref.sourceId, fieldId, rawValue)
    if (ok) {
      // 新しい options を store の defs へ反映してから再取得する。defs は config のクローンのため、
      // setSourcesFromConfig で同期しないと client producer が旧 options で fetch してしまう (#36 が
      // #40 へ先送りした「単位変更の即時反映」ギャップ)。urlset 不変なので他 source は再 fetch されない。
      setSourcesFromConfig(config)
      refreshSourceById(ref.sourceId)
    }
  }
  if (!ok) return
  void saveConfig(config)
  render()
}

function onSegVisChange(e: Event): void {
  const t = e.target as HTMLInputElement | HTMLSelectElement
  const action = t.dataset.action
  const key = t.dataset.key
  const segId = t.dataset.seg
  if (!action?.startsWith('seg-vis-') || !key || !segId) return
  const ref = parseKey(key)
  const sm = config.groups[ref.sourceId]?.[ref.groupId]?.segments.find((s) => s.id === segId)
  const vis = sm?.visibility
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
            : val === 'inPlace'
              ? { kind: 'inPlace', placeId: config.places?.[0]?.id ?? '' }
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
  void saveConfig(config)
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
  // fetchMachineFrom は machineId が非空 string のときだけ object を返す (parseMachineInfo)。
  // null は「接続失敗」または「接続成功だが machineId 不明」を意味し、後者でも空 machineId を
  // reconcile に渡さない (空 machineId による別マシン誤合流 = データ破壊を構造的に防ぐ)。
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
    // テストした経路を urls に足す (上書きしない = 既存経路を温存し複数経路を束ねる)。
    if (!src.urls.includes(clean)) src.urls.push(clean)
    src.url ??= clean // 後方互換の主 url は初回のみ設定
    src.label = m.label
    // machineId を反映して id を安定化する。同 machineId の既存 source への合流 / 旧 randomUUID の
    // id 付け替え / tombstone からの view 復元はすべて reconcileSourceMachine が担う。
    const settled = reconcileSourceMachine(config, editingSourceId, m.machineId, clean)
    if (settled) editingSourceId = settled.id // 合流/再 key で id が変わったら追従
  }
  await saveConfig(config)
  testState = 'ok'
  setSourcesFromConfig(config) // store に新 URL を反映 → 取得 → onStoreUpdate で再描画
  render()
}

function onStoreUpdate(): void {
  syncAll() // 新 group を config に取り込み (永続)
  maybeGeofenceAutoSwitch() // #43 現在地 place 変化で auto モードの preset へ自動切替(view 非依存=glass にも効く)
  if (view !== 'home') return
  // 接続状態 (online/stale/offline) の変化で提案を再計算する。提案の出現/消滅/差し替えが
  // あれば Home を再描画する (バナーの表示更新)。dismiss 済みは recomputeSuggestion 内で除外。
  const suggestionChanged = recomputeSuggestion()
  // 表示項目の構成 (status の有無で変わる) が変化したときだけ項目リストを再描画。
  // 値だけの更新では再描画しない (毎 poll の innerHTML churn が iOS WebContent jettison を招くため。
  // プレビューはモックなので値追従はユーザー編集/構成変化/並べ替えで十分。issue #4)。
  if (suggestionChanged || visibleSig() !== lastVisibleSig) render()
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
  if (isCustomLabelKey(key))
    return activeView(config).glassLayout?.customLabels[customLabelId(key)]?.text ?? ''
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
  return activeView(config).groups[sourceId]?.[groupId]?.showDefaultLabel ?? groupId !== 'clock'
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
  const lay = activeView(config).glassLayout
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
  const lay = activeView(config).glassLayout
  if (!lay) return
  lay.rows = lay.rows.map((r) => {
    const { left, right } = splitRowClusters(r)
    return right.length ? [...left, RIGHT_DIVIDER, ...right] : left
  })
}

function removeFsKey(key: string): void {
  const lay = activeView(config).glassLayout
  if (lay) lay.rows = lay.rows.map((r) => r.filter((k) => k !== key))
}

function moveFsKeyToZone(key: string, rowIdx: number, side: 'left' | 'right'): void {
  const lay = activeView(config).glassLayout
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
  if (!drag || !activeView(config).glassLayout) return
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
    if (key && activeView(config).glassLayout) {
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

// ── デバッグコンソール本体 ──
function dbgTime(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const MAX_DBG_LINE = 2000 // 1 ログ行の最大文字数 (巨大オブジェクト/長文での DOM・stringify 肥大を防ぐ)
// token/secret 等を含むキーを伏せる (プローブが生レスポンスを UI に出すため redaction する)。
const SENSITIVE_KEY =
  /token|secret|password|passwd|api[-_]?key|authorization|auth|cookie|session|credential/i

// オブジェクトを浅くクローンしつつ、機微なキーの値を伏せる。ログ前の生レスポンスに適用する。
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '«depth»'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '«redacted»' : redact(v, depth + 1)
    }
    return out
  }
  return value
}

// console.* の可変長引数を 1 行テキストにする。Error は stack、オブジェクトは JSON。1 行上限で truncate。
function dbgFormat(args: unknown[]): string {
  const s = args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
      try {
        return JSON.stringify(a)
      } catch {
        return String(a) // 循環参照等
      }
    })
    .join(' ')
  return s.length > MAX_DBG_LINE ? `${s.slice(0, MAX_DBG_LINE)} …(+${s.length - MAX_DBG_LINE})` : s
}

function dbgPush(level: DbgLevel, text: string): void {
  const e: DbgEntry = { t: Date.now(), level, text }
  dbgLogs.push(e)
  if (dbgLogs.length > DBG_MAX) dbgLogs.splice(0, dbgLogs.length - DBG_MAX)
  appendDbgLineToDom(e)
  updateDbgCount()
}

function matchesFilter(text: string): boolean {
  return !dbgFilter || text.toLowerCase().includes(dbgFilter.toLowerCase())
}

function dbgLineHtml(e: DbgEntry): string {
  return `<div class="dbgc-line dbgc-${e.level}"><span class="dbgc-t">${dbgTime(e.t)}</span><span class="dbgc-msg">${esc(e.text)}</span></div>`
}

function dbgListInnerHtml(): string {
  const rows = dbgLogs.filter((e) => matchesFilter(e.text))
  return rows.length ? rows.map(dbgLineHtml).join('') : '<div class="cmp-sub">No logs</div>'
}

function updateDbgCount(): void {
  const c = document.getElementById('dbg-count')
  if (c) c.textContent = String(dbgLogs.length)
}

function scrollDbgBottom(): void {
  const list = document.getElementById('dbg-list')
  if (list) list.scrollTop = list.scrollHeight
}

// フィルタ変更・Clear 時にリストだけ差し替える (full render を避け、入力の focus を保つ)。
function updateDbgListDom(): void {
  const list = document.getElementById('dbg-list')
  if (!list) return
  list.innerHTML = dbgListInnerHtml()
  scrollDbgBottom()
}

// 新規 1 行を直接 append (パネルが開いている間のみ)。full render を起こさず churn を抑える。
function appendDbgLineToDom(e: DbgEntry): void {
  if (!dbgOpen) return
  const list = document.getElementById('dbg-list')
  if (!list) return
  if (!matchesFilter(e.text)) return
  if (list.firstElementChild?.classList.contains('cmp-sub')) list.innerHTML = '' // "No logs" を除去
  list.insertAdjacentHTML('beforeend', dbgLineHtml(e))
  while (list.children.length > DBG_MAX) list.firstElementChild?.remove()
  scrollDbgBottom()
}

// クリップボードへ書き込む。Clipboard API → 失敗時は textarea+execCommand にフォールバック
// (WKWebView や非セキュアコンテキストで API が使えない場合に備える)。
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // フォールバックへ
  }
  // textarea+execCommand フォールバック。select() が現在の focus/選択を奪うため、
  // 直前の active 要素・入力カーソル・document 選択範囲を保存し finally で復元する。
  // textarea 除去も finally に置き、例外時に DOM へ残らないようにする。
  const prevActive = document.activeElement
  const prevInput =
    prevActive instanceof HTMLInputElement || prevActive instanceof HTMLTextAreaElement
      ? prevActive
      : null
  const inputSel = prevInput
    ? { start: prevInput.selectionStart, end: prevInput.selectionEnd }
    : null
  const sel = window.getSelection()
  const ranges: Range[] = sel
    ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i))
    : []
  const ta = document.createElement('textarea')
  try {
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
    if (sel) {
      sel.removeAllRanges()
      for (const r of ranges) sel.addRange(r)
    }
    if (prevActive instanceof HTMLElement) prevActive.focus()
    if (prevInput && inputSel && inputSel.start != null && inputSel.end != null) {
      try {
        prevInput.setSelectionRange(inputSel.start, inputSel.end)
      } catch {
        // 一部の input type は setSelectionRange 非対応 (無視)
      }
    }
  }
}

// ボタン文言を一時的に差し替えて結果を知らせる (Copied / Failed)。
function flashBtn(btn: HTMLElement, label: string): void {
  const prev = btn.textContent ?? ''
  btn.textContent = label
  window.setTimeout(() => {
    btn.textContent = prev
  }, 1200)
}

// 表示中 (フィルタ適用後) のログをテキストでコピーする。
async function copyDbgLogs(btn: HTMLElement | null): Promise<void> {
  const rows = dbgLogs.filter((e) => matchesFilter(e.text))
  const text = rows.map((e) => `${dbgTime(e.t)} ${e.level.toUpperCase()} ${e.text}`).join('\n')
  const ok = await writeClipboard(text)
  if (btn) flashBtn(btn, ok ? 'Copied' : 'Failed')
}

// glass preview の下に出す折りたたみコンソール。閉じている間はヘッダ 1 行のみ。
function renderDbgConsole(): string {
  const caret = icon(dbgOpen ? 'chevron-down' : 'chevron-right', { size: 16 })
  const actions = dbgOpen
    ? `<span class="cmp-actions">
        <button class="link-btn" data-action="probe-userinfo" title="bridge.getUserInfo()">User</button>
        <button class="link-btn" data-action="probe-geo" title="navigator.geolocation">Geo</button>
        <button class="link-btn" data-action="probe-ip" title="IP ジオロケーション">IP</button>
        <button class="link-btn" data-action="console-copy" title="表示中のログをコピー">Copy</button>
        <button class="link-btn" data-action="console-clear">Clear</button>
      </span>`
    : ''
  const head = `<div class="cmp-label cmp-label-row">
      <button class="dbgc-toggle" data-action="console-toggle">${caret} Console <span id="dbg-count" class="dbgc-count">${dbgLogs.length}</span></button>
      ${actions}
    </div>`
  if (!dbgOpen) return head
  return `${head}
    <div class="dbgc">
      <input class="dbgc-filter" type="text" placeholder="Filter…" value="${esc(dbgFilter)}" aria-label="Filter logs" />
      <div id="dbg-list" class="dbgc-list">${dbgListInnerHtml()}</div>
    </div>`
}

// console.* を捕捉してパネルにも流す (元の console もそのまま呼ぶ)。未捕捉例外も拾う。
function hookConsole(): void {
  if (dbgHooked) return
  dbgHooked = true
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }
  console.log = (...a: unknown[]) => {
    dbgPush('log', dbgFormat(a))
    orig.log(...a)
  }
  console.info = (...a: unknown[]) => {
    dbgPush('info', dbgFormat(a))
    orig.info(...a)
  }
  console.warn = (...a: unknown[]) => {
    dbgPush('warn', dbgFormat(a))
    orig.warn(...a)
  }
  console.error = (...a: unknown[]) => {
    dbgPush('error', dbgFormat(a))
    orig.error(...a)
  }
  window.addEventListener('error', (ev) => dbgPush('error', `[window.error] ${ev.message}`))
  window.addEventListener('unhandledrejection', (ev) =>
    dbgPush('error', `[unhandledrejection] ${dbgFormat([ev.reason])}`),
  )
}

// ── 検証プローブ (結果は console.* 経由でパネルへ) ──
async function probeUserInfo(): Promise<void> {
  if (!probeBridge) {
    console.warn('[probe] bridge 未接続 — Even App / simulator 上で実行してください')
    return
  }
  try {
    const u = await probeBridge.getUserInfo()
    console.log('[probe] getUserInfo →', redact(u.toJson())) // PII を含むため機微キーは伏せる
  } catch (err) {
    console.error('[probe] getUserInfo 失敗', err)
  }
}

function probeGeo(): void {
  if (!('geolocation' in navigator)) {
    console.warn('[probe] navigator.geolocation が無い')
    return
  }
  console.log('[probe] geolocation 要求中 (許可ダイアログが出る場合あり)…')
  navigator.geolocation.getCurrentPosition(
    (pos) =>
      console.log('[probe] geolocation →', {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
      }),
    (err) => console.error(`[probe] geolocation 失敗 code=${err.code} ${err.message}`),
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 0 },
  )
}

async function probeIp(): Promise<void> {
  // 外部サービスへ IP を送るため、クリック時に明示同意を取る (プライバシー)。
  if (
    !window.confirm(
      'IP ジオロケーション検証のため、外部サービス(ipapi.co 等)にあなたの IP を送信します。続行しますか？',
    )
  ) {
    console.log('[probe] IP geo: キャンセル')
    return
  }
  // キー不要の IP ジオロケーションを順に試す (CORS 許可のあるもの優先)。
  // credentials 無し・referrer 無しで最小限の送信に留める。
  const endpoints = [
    'https://ipapi.co/json/',
    'https://ipwho.is/',
    'https://get.geojs.io/v1/ip/geo.json',
  ]
  for (const url of endpoints) {
    try {
      console.log('[probe] IP geo fetch:', url)
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      const json = (await res.json()) as unknown
      console.log('[probe] IP geo →', redact(json)) // 機微キーは伏せる
      return
    } catch (err) {
      console.warn(`[probe] IP geo 失敗 ${url}:`, err instanceof Error ? err.message : err)
    }
  }
  console.error('[probe] IP geo: すべての候補が失敗')
}

// フィルタ入力 (live)。リストだけ差し替えて入力 focus を保つ。
function onInput(e: Event): void {
  const t = e.target
  if (t instanceof HTMLInputElement && t.classList.contains('dbgc-filter')) {
    dbgFilter = t.value
    updateDbgListDom()
  }
}

export async function mountCompanion(el: HTMLElement): Promise<void> {
  root = el
  hookConsole() // 早期の console も拾えるよう最初に仕込む
  el.addEventListener('click', (e) => void onClick(e))
  el.addEventListener('change', (e) => void onChange(e)) // segment 条件 / 表示オプションの select/number
  el.addEventListener('input', onInput) // デバッグコンソールのフィルタ
  subscribe(onStoreUpdate)

  config = await loadConfig()
  // OD-4: dev (ブラウザ / 同一オリジン) のみ自動登録。prod (.ehpk) は location.origin が
  // glasses 側ループバックを指し Mac に届かないため登録せず、help.html の手順で LAN IP を入力させる。
  if (import.meta.env.DEV && ensureDefaultServer(config, location.origin)) await saveConfig(config)
  setSourcesFromConfig(config)
  startPolling()
  render() // 時刻 (clock) は glass-local タイマーが所有。companion は周期再描画しない
}

// bridge 接続後: 永続 config を読み直して store に反映する。
export async function onCompanionBridgeReady(): Promise<void> {
  config = await loadConfig()
  // OD-4: 自動登録は dev のみ (prod は help.html の手順で LAN IP を入力させる)。
  if (import.meta.env.DEV && ensureDefaultServer(config, location.origin)) await saveConfig(config)
  setSourcesFromConfig(config)
  render()
}
