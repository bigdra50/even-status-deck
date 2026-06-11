// companion の group/segment/source 行 HTML を組み立てる純 render 部品層。
// ctx(./state)・sync(./sync)・外部モジュールだけに依存し、index/debug-console は import しない (no-circular)。
import {
  activeView,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SEG_LABELS,
  BUILTIN_SOURCE_ID,
  customLabelKey,
  type GroupRef,
  groupDisplayName,
  type SegMeta,
  type SourceDef,
  sourceById,
  sourceUrl,
} from '../config'
import { effectiveGroupHeading, normalizeHeading } from '../display-identity'
import { esc } from '../escape'
import { icon } from '../icons'
import {
  resolveSegmentOptions,
  resolveSourceOptions,
  segmentOptionSchema,
  sourceOptionSchema,
} from '../options'
import type { Segment } from '../status-types'
import { getLastSuccessAt, getSourceHealth } from '../store'
import { segKey } from '../visibility'
import { actionButton } from './html'
import { optionControls } from './rows-options'
import { segVisEditor } from './rows-visibility'
import { ctx } from './state'
import { editingLayout, statusGroup, visibleRefs, worstReportedState } from './sync'

// sourceId 内で headingKey (正規化済み見出し) が一致する別 group のうち、いずれかの profile の
// view.groupOrder で groupId と共存している (= その preset で実際にマージが起きる) ものを返す。
// 描画 (computeGroupMergeUnits) と同じ resolver/正規化を共有 = 「表示はマージ・併記なし」のズレを防ぐ。
// スコープは「全 profile の groupOrder 共存」: rename と素材は全 profile 共有なので active view 限定
// では他 preset のマージを見逃し、素材全体では どの preset でも共存しない group まで誤検出する。
export function headingCollidesInSomeProfile(
  sourceId: string,
  groupId: string,
  headingKey: string,
): string | null {
  if (!headingKey) return null
  const rivals = Object.keys(ctx.config.groups[sourceId] ?? {}).filter(
    (gid) =>
      gid !== groupId &&
      normalizeHeading(effectiveGroupHeading(ctx.config, sourceId, gid)) === headingKey,
  )
  if (!rivals.length) return null
  const inOrder = (order: GroupRef[], gid: string) =>
    order.some((r) => r.sourceId === sourceId && r.groupId === gid)
  for (const rival of rivals) {
    const merges = ctx.config.profiles.some(
      (p) => inOrder(p.view.groupOrder, groupId) && inOrder(p.view.groupOrder, rival),
    )
    if (merges) return rival
  }
  return null
}

// ref の現在の見出しが (どこかの preset で) 別 group とマージされるか。同名行への group id 併記判定。
export function groupHeadingCollides(sourceId: string, groupId: string): boolean {
  const mine = normalizeHeading(effectiveGroupHeading(ctx.config, sourceId, groupId))
  return headingCollidesInSomeProfile(sourceId, groupId, mine) !== null
}

// 1 segment の metric 行 (設定面)。live 未出現でも meta にあれば placeholder 値で描く。
function metricRow(
  key: string,
  ref: GroupRef,
  sm: SegMeta,
  segById: Map<string, Segment>,
  isBuiltin: boolean,
  enabled: boolean,
): string {
  // Items は設定面なので、live status に未出現の segment も meta にあれば行を描く
  // (placeholder 値 '—')。トグル/並べ替え/配置/表示条件を事前設定できる。値は status のみ。
  const live = segById.get(sm.id)
  const seg: Segment = live ?? { id: sm.id, label: sm.displayLabel ?? '', value: '—' }
  const missing = !live
  // segment 単位の表示オプション (#36)。clock の Time/Date/順序 もこの schema 経由で描く。
  const segFields = segmentOptionSchema(ref.sourceId, ref.groupId, sm.id)
  const segOpts = segFields.length
    ? optionControls(
        key,
        sm.id,
        'segment',
        segFields,
        resolveSegmentOptions(ctx.config, ref.sourceId, ref.groupId, sm.id),
      )
    : ''
  return `<div class="metric${missing ? ' missing' : ''}"><div class="metric-row"><span class="mgrip">${icon('grip', { size: 16 })}</span>
              <span class="mname">${esc(isBuiltin ? (BUILTIN_SEG_LABELS[seg.id] ?? seg.id) : seg.label || seg.id)}</span>
              <span class="mval">${esc(seg.value)}</span>
              <button class="tg sm ${enabled ? 'on' : ''}" data-action="toggle-seg" data-key="${key}" data-seg="${esc(sm.id)}"></button></div>
            ${segOpts}
            ${segVisEditor(key, sm)}</div>`
}

// group 展開時の segment metric 行群 (.src-metrics コンテナ含む)。
function groupMetricsHtml(
  key: string,
  ref: GroupRef,
  meta: { segments: SegMeta[] },
  segById: Map<string, Segment>,
  isBuiltin: boolean,
  vg: { segments: Record<string, boolean | undefined> },
): string {
  // segment の並びは素材 (meta.segments)、ON/OFF・条件は view/素材から引く。
  // source 単位の表示オプション (#36)。素材 = 全 profile 共有。スキーマが空なら描かない。
  // srcOpts は .src-metrics の「外」(直前) に出す。.src-metrics は SortableJS の segment 並べ替え
  // コンテナで、onSegReorder が e.oldIndex(= 全直接子の index) を meta.segments index として使うため、
  // 非 segment ノードを中に混ぜると index が +1 ずれて別 segment を動かす (silent なデータ破損)。
  const srcFields = sourceOptionSchema(ref.sourceId)
  const srcOpts = srcFields.length
    ? optionControls(key, '', 'source', srcFields, resolveSourceOptions(ctx.config, ref.sourceId))
    : ''
  const rows = meta.segments
    .map((sm) => metricRow(key, ref, sm, segById, isBuiltin, vg.segments[sm.id] ?? true))
    .join('')
  return `${srcOpts}<div class="src-metrics" data-key="${key}">${rows}</div>`
}

// group 行の provider 由来タグ (非 builtin で source label を併記)。
function groupSrcTag(isBuiltin: boolean, src: SourceDef | undefined, ref: GroupRef): string {
  if (isBuiltin) return ''
  if (!src || src.id !== ref.sourceId) return ''
  return `<span class="src-note">${esc(src.label)}</span>`
}

// group 行ヘッダ HTML (caret / 名前 / 衝突タグ / 操作ボタン)。
function groupRowHead(
  key: string,
  ref: GroupRef,
  title: string,
  caret: string,
  src: SourceDef | undefined,
  isBuiltin: boolean,
  vg: { enabled: boolean; showDefaultLabel?: boolean },
): string {
  const srcTag = groupSrcTag(isBuiltin, src, ref)
  // 同 source 内で同名の group は glass で 1 unit にマージされる。管理面は per-group なので
  // どの provider 由来か分かるよう group id を淡色併記する (衝突時のみ)。
  const gidTag = groupHeadingCollides(ref.sourceId, ref.groupId)
    ? `<span class="src-note">${esc(ref.groupId)}</span>`
    : ''
  // default-label トグル (glass で group 名を前置するか)。位置/上詰めは Glass layout で決める。
  const showsLabel = vg.showDefaultLabel ?? ref.groupId !== 'clock'
  const labelBtn = actionButton('toggle-grouplabel', icon('tag', { size: 15 }), {
    cls: `label-btn ${showsLabel ? 'on' : ''}`,
    extra: `data-key="${key}"`,
    title: showsLabel ? 'Group label shown on glass' : 'Group label hidden',
  })
  // group 名のリネーム (Source Detail)。同 source 内で同名の group は glass で 1 unit にマージ表示される。
  const renameBtn = actionButton('edit-groupname', icon('pencil', { size: 14 }), {
    cls: 'label-btn',
    extra: `data-key="${key}"`,
    title: 'Rename group',
    ariaLabel: 'Rename group',
  })
  // owner は Source Detail ヘッダで編集 / glass picker でバッジ表示する (表示モデル新 IA)。group 行には出さない。
  return `<div class="src-head"><span class="src-grip">${icon('grip', { size: 16 })}</span>
    <span class="src-caret" data-action="expand" data-key="${key}">${caret}</span>
    <span class="src-name" data-action="expand" data-key="${key}">${esc(title)}</span>
    ${gidTag}
    ${srcTag}
    ${renameBtn}
    ${labelBtn}
    <button class="tg ${vg.enabled ? 'on' : ''}" data-action="toggle-group" data-key="${key}"></button></div>`
}

function groupRow(ref: GroupRef): string {
  const g = statusGroup(ref.sourceId, ref.groupId)
  const meta = ctx.config.groups[ref.sourceId]?.[ref.groupId]
  const vg = activeView(ctx.config).groups[ref.sourceId]?.[ref.groupId]
  if (!g || !meta || !vg) return ''
  const src = sourceById(ctx.config, ref.sourceId)
  const isBuiltin = ref.sourceId === BUILTIN_SOURCE_ID
  const key = `${esc(ref.sourceId)}|${esc(ref.groupId)}`
  // 行名: 衝突解決/手動の displayName を最優先。無ければ builtin はコード所有ラベル、他は live label。
  const baseTitle = isBuiltin
    ? (BUILTIN_GROUP_LABELS[ref.groupId] ?? ref.groupId)
    : g.label || src?.label || ref.groupId
  const title = meta.displayName ?? baseTitle
  const caret = icon(vg.expanded ? 'chevron-down' : 'chevron-right', { size: 16 })
  const segById = new Map(g.segments.map((s) => [s.id, s]))
  const metrics = vg.expanded ? groupMetricsHtml(key, ref, meta, segById, isBuiltin, vg) : ''
  const head = groupRowHead(key, ref, title, caret, src, isBuiltin, vg)
  return `<div class="src" data-key="${key}">${head}${metrics}</div>`
}

// 1 source の group 行群 (Source Detail 用)。group の横断並べ替えは Glass Layout が持つので
// ここでは #source-list を使わず (group sortable を張らない)、segment 並べ替え (.src-metrics) のみ効く。
export function renderSourceGroups(sourceId: string): string {
  const refs = visibleRefs().filter((r) => r.sourceId === sourceId)
  if (!refs.length) return '<div class="cmp-sub">No data from this source yet.</div>'
  return refs.map((r) => groupRow(r)).join('')
}

// client source (weather 等) の dot/note。URL は無く現在地ベース。
function clientSourceDotNote(s: SourceDef): { dotCls: string; note: string } {
  const health = getSourceHealth(s.id)
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

// server / その他 source の dot/note (transport health + reported state)。
function serverSourceDotNote(s: SourceDef): { dotCls: string; note: string } {
  const health = getSourceHealth(s.id)
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

// ── source 行 (3 文脈: Home=preset 内 / Sources 一覧 / preset へ追加) ──
// 接続状態 dot と note (online=緑 / stale=琥珀 / offline=灰+"Last seen…")。
// transport が online でもソースが degraded を報告していれば琥珀 + message を出す (2 軸)。
export function sourceDotNote(s: SourceDef): { dotCls: string; note: string } {
  if (s.kind === 'client') return clientSourceDotNote(s)
  return serverSourceDotNote(s)
}

// Home の provenance セクション (view 限定の grouping。データモデルに tier 実体は足さない)。
// 見出し = 出自、行 = 既存の dot+note が capability を表す (codex: 見出しに permission を混ぜない)。
// 判定は kind + origin: builtin / app_bundled client は Included、server は Connected、
// user_added client (将来の外部 provider) は Extensions。
type SourceSection = 'included' | 'connected' | 'extensions'
export function sourceSection(s: SourceDef): SourceSection {
  if (s.kind === 'server') return 'connected'
  if (s.kind === 'client' && s.origin !== 'app_bundled') return 'extensions'
  return 'included' // builtin + app_bundled client (Device / Location)
}
export const SOURCE_SECTIONS: { key: SourceSection; label: string; hint: string }[] = [
  { key: 'included', label: 'Included', hint: 'Bundled with the app' },
  { key: 'connected', label: 'Connected', hint: 'Servers you run' },
  { key: 'extensions', label: 'Extensions', hint: 'Added providers' },
]

// Home: この preset で使う source の nav カード (新 IA)。tap で Source Detail へドリルダウン。
// builtin(Device) も含めて出す。preset から外すのは横スワイプ→🗑 (iOS 風 swipe-to-delete)。
export function sourceNavRow(s: SourceDef): string {
  const isBuiltin = s.kind === 'builtin'
  const { dotCls, note } = isBuiltin ? { dotCls: '', note: 'On-device' } : sourceDotNote(s)
  // 前面 (タップで Source Detail へ)。横スワイプでこれを左へずらし背面の🗑を露出する。
  const fg = `<div class="swipe-fg" data-action="open-source-detail" data-src="${esc(s.id)}" role="button" tabindex="0">
    <span class="conn-dot ${dotCls}"></span>
    <span class="src-name">${esc(s.label)}</span>
    <span class="src-note">${esc(note)}</span>
    <span class="src-chev">${icon('chevron-right', { size: 16 })}</span></div>`
  // builtin(Device) は preset から外せない(常時有効) ので swipe 無し・🗑無し。
  if (isBuiltin) return `<div class="src swipe-row">${fg}</div>`
  // 背面: 右端の削除(remove-from-preset)。前面が左へずれると露出する。
  const delBtn = actionButton('remove-from-preset', icon('trash', { size: 18 }), {
    cls: 'swipe-del',
    attrs: { 'data-src': s.id, 'aria-label': 'Remove from preset', title: 'Remove from preset' },
  })
  const bg = `<div class="swipe-bg">${delBtn}</div>`
  return `<div class="src swipe-row" data-src="${esc(s.id)}" data-swipeable="1">${bg}${fg}</div>`
}

// Sources 一覧: 全 source 実体の管理。編集 (URL/machineId/削除) へ。
export function sourceManageRow(s: SourceDef): string {
  const { dotCls, note } = sourceDotNote(s)
  const editBtn = actionButton('edit-source', icon('settings', { size: 18 }), {
    cls: 'gear-btn',
    attrs: { 'data-src': s.id },
    title: 'Edit',
    ariaLabel: 'Edit',
  })
  return `<div class="src"><div class="src-head"><span class="conn-dot ${dotCls}"></span>
    <span class="src-name">${esc(s.label)}</span>
    <span class="src-note">${esc(note)}</span>
    ${editBtn}</div></div>`
}

// preset への追加候補: まだこの preset に無い source。タップで preset へ追加。
export function sourceAddRow(s: SourceDef): string {
  const { dotCls, note } = sourceDotNote(s)
  const addBtn = actionButton('add-to-preset', 'Add', {
    cls: 'link-btn',
    attrs: { 'data-src': s.id },
    title: 'Add to this preset',
  })
  return `<div class="src"><div class="src-head"><span class="conn-dot ${dotCls}"></span>
    <span class="src-name">${esc(s.label)}</span>
    <span class="src-note">${esc(note)}</span>
    ${addBtn}</div></div>`
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
export function segLabelParts(key: string): { group: string; seg: string } {
  const [sourceId, groupId, segId] = key.split('|')
  // group 名は displayName(衝突解決/手動) を最優先。無ければ builtin=コード所有 / 他=live label。
  const override = groupDisplayName(ctx.config, sourceId, groupId)
  if (sourceId === BUILTIN_SOURCE_ID) {
    return {
      group: override ?? BUILTIN_GROUP_LABELS[groupId] ?? groupId,
      seg: BUILTIN_SEG_LABELS[segId] ?? segId,
    }
  }
  const g = statusGroup(sourceId, groupId)
  const seg = g?.segments.find((s) => s.id === segId)
  return {
    group: override ?? (g?.label || sourceById(ctx.config, sourceId)?.label || groupId),
    seg: seg?.label || segId,
  }
}

// 配置可能な全 key (active view の groupOrder 順)。未配置リストの母集合。
// group ラベルは default-label (group 単位トグル) が自動で出すので chip にはしない。
export function allPlaceableKeys(): string[] {
  const view = activeView(ctx.config)
  const keys: string[] = []
  for (const ref of view.groupOrder) {
    const meta = ctx.config.groups[ref.sourceId]?.[ref.groupId]
    const vg = view.groups[ref.sourceId]?.[ref.groupId]
    if (!meta || !vg) continue
    for (const sm of meta.segments) {
      if (vg.segments[sm.id] ?? true) keys.push(segKey(ref.sourceId, ref.groupId, sm.id))
    }
  }
  // ユーザー定義の custom ラベル
  for (const id of Object.keys(editingLayout()?.customLabels ?? {})) keys.push(customLabelKey(id))
  return keys
}
