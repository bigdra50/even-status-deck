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
  type OptionValues,
  type SegMeta,
  type SourceDef,
  sourceById,
  sourceUrl,
} from '../config'
import { effectiveGroupHeading, normalizeHeading } from '../display-identity'
import { esc } from '../escape'
import { icon } from '../icons'
import {
  type OptionField,
  type OptionScope,
  resolveSegmentOptions,
  resolveSourceOptions,
  segmentOptionSchema,
  sourceOptionSchema,
} from '../options'
import type { Segment } from '../status-types'
import { getLastSuccessAt, getSourceHealth } from '../store'
import { segKey, type VisibilityLeaf } from '../visibility'
import { actionButton, actionSelect, optionsHtml, type SelectOption } from './html'
import { ctx } from './state'
import { editingLayout, parseKey, statusGroup, visibleRefs, worstReportedState } from './sync'

// 1 segment が持てる条件 leaf の上限 (UI が破綻しない緩い上限)。
export const MAX_CONDS = 4
const DEFAULT_DISPLAY_SECS = 5 // 提示 (toast/notification) の既定 自動非表示秒数

// 表示条件の対象 segment 候補 (同 group 内)。label は表示用、hasPct は live で percent を持つか
// (threshold 候補の判定に使う)。母集合は素材 (meta.segments)、percent は live status から補う。
type SegChoice = { id: string; label: string; hasPct: boolean }
export function segChoicesFor(ref: GroupRef): SegChoice[] {
  const metaSegs = ctx.config.groups[ref.sourceId]?.[ref.groupId]?.segments ?? []
  const liveG = statusGroup(ref.sourceId, ref.groupId)
  const isB = ref.sourceId === BUILTIN_SOURCE_ID
  return metaSegs.map((s) => {
    const live = liveG?.segments.find((x) => x.id === s.id)
    const label = isB ? (BUILTIN_SEG_LABELS[s.id] ?? s.id) : live?.label || s.id
    return { id: s.id, label, hasPct: typeof live?.percent === 'number' }
  })
}

// 対象 segment select。選択中 id が候補に無くても (live 消失等) option を補い選択を保持する。
// selfId 指定時はその option に "(this)" を付す (self を選ぶと保存側は seg を省略する)。
function targetSelect(a: string, choices: SegChoice[], selected: string, selfId?: string): string {
  const list = choices.some((c) => c.id === selected)
    ? choices
    : [...choices, { id: selected, label: selected || '?', hasPct: false }]
  const options = list.map((c) => ({
    value: c.id,
    label: `${c.label}${selfId && c.id === selfId ? ' (this)' : ''}`,
    selected: c.id === selected,
  }))
  return actionSelect('seg-vis-leaf-seg', options, { cls: 'vis-select', extra: a })
}

// present leaf の params (兄弟 segment 必須)。
function leafPresentParams(
  a: string,
  leaf: Extract<VisibilityLeaf, { kind: 'present' }>,
  choices: SegChoice[],
  sibs: SegChoice[],
): string {
  const opts = sibs.length ? sibs : choices.filter((c) => c.id === leaf.seg)
  const absentSelect = actionSelect(
    'seg-vis-leaf-absent',
    [
      { value: 'present', label: 'has value', selected: !leaf.absent },
      { value: 'absent', label: 'is empty', selected: !!leaf.absent },
    ],
    { cls: 'vis-select', extra: a },
  )
  return `${targetSelect(a, opts, leaf.seg)}
      ${absentSelect}`
}

// threshold leaf の params。対象候補は percent を持つ segment (self/兄弟)。
function leafThresholdParams(
  a: string,
  leaf: Extract<VisibilityLeaf, { kind: 'threshold' }>,
  choices: SegChoice[],
  selfId: string,
): string {
  // 保存済み対象は targetSelect が補完する。
  const pctChoices = choices.filter((c) => c.hasPct)
  const tsel =
    pctChoices.length >= 2 || leaf.seg
      ? targetSelect(a, pctChoices, leaf.seg ?? selfId, selfId)
      : ''
  const opSelect = actionSelect(
    'seg-vis-leaf-op',
    [
      { value: 'gte', label: '≥', selected: leaf.op === 'gte' },
      { value: 'lte', label: '≤', selected: leaf.op === 'lte' },
    ],
    { cls: 'vis-select', extra: a },
  )
  return `${tsel}${opSelect}
      <input class="vis-num" type="number" min="0" max="100" data-action="seg-vis-leaf-value" ${a} value="${leaf.value}" />%`
}

// onChange leaf の params。兄弟があれば対象 select を出す (省略=self)。
function leafOnChangeParams(
  a: string,
  leaf: Extract<VisibilityLeaf, { kind: 'onChange' }>,
  choices: SegChoice[],
  selfId: string,
): string {
  const tsel = choices.length >= 2 ? targetSelect(a, choices, leaf.seg ?? selfId, selfId) : ''
  return `${tsel}<input class="vis-num" type="number" min="1" max="60" data-action="seg-vis-leaf-hold" ${a} value="${Math.round(leaf.holdMs / 1000)}" />s`
}

// leaf の params (kind 別)。threshold/onChange は対象 (self/兄弟) を選べる。present は兄弟必須。
function leafParams(
  a: string,
  leaf: VisibilityLeaf,
  choices: SegChoice[],
  sibs: SegChoice[],
  selfId: string,
): string {
  if (leaf.kind === 'present') return leafPresentParams(a, leaf, choices, sibs)
  if (leaf.kind === 'threshold') return leafThresholdParams(a, leaf, choices, selfId)
  return leafOnChangeParams(a, leaf, choices, selfId)
}

// 1 leaf 行 (kind select + 対象/params + 削除ボタン)。threshold は同 group に percent を持つ segment が
// ある時のみ候補。present は対象に別 segment が要るので兄弟がある時のみ。既存 leaf は条件を満たさなくても
// 自分の kind を候補に残す (data 移行後の編集を壊さない)。
function leafRow(
  seg2: string,
  leaf: VisibilityLeaf,
  i: number,
  choices: SegChoice[],
  selfId: string,
  groupHasPct: boolean,
): string {
  const a = `${seg2} data-idx="${i}"`
  const sibs = choices.filter((c) => c.id !== selfId)
  const allowThreshold = groupHasPct || leaf.kind === 'threshold'
  const allowPresent = sibs.length > 0 || leaf.kind === 'present'
  const kindOptions: SelectOption[] = []
  if (allowThreshold) {
    kindOptions.push({ value: 'threshold', label: 'When…', selected: leaf.kind === 'threshold' })
  }
  kindOptions.push({ value: 'onChange', label: 'On update', selected: leaf.kind === 'onChange' })
  if (allowPresent) {
    kindOptions.push({ value: 'present', label: 'Has value', selected: leaf.kind === 'present' })
  }
  const kindSel = actionSelect('seg-vis-leaf-kind', kindOptions, { cls: 'vis-select', extra: a })
  const params = leafParams(a, leaf, choices, sibs, selfId)
  const del = actionButton('seg-vis-remove', icon('x', { size: 14 }), {
    cls: 'vis-del',
    extra: a,
    title: 'Remove',
    ariaLabel: 'Remove',
  })
  return `<div class="vis-cond-row">${kindSel}${params}${del}</div>`
}

// 提示先行。条件があるときのみ。Inline=現状の常時表示 / Toast・Notification は成立時に提示し自動非表示 (排他)。
// toast/notification とも自動消去するので秒数フィールドを出す (既定 DEFAULT_DISPLAY_SECS)。
function segVisDisplayRow(seg2: string, sm: SegMeta, conditionsLength: number): string {
  if (conditionsLength === 0) return ''
  const display = sm.visibility?.display
  const secs = display?.durationMs ? Math.round(display.durationMs / 1000) : DEFAULT_DISPLAY_SECS
  const uiSelect = actionSelect(
    'seg-vis-display-ui',
    [
      { value: '', label: 'Inline (persistent)', selected: !display },
      { value: 'toast', label: 'Toast', selected: display?.ui === 'toast' },
      { value: 'notification', label: 'Notification', selected: display?.ui === 'notification' },
    ],
    { cls: 'vis-select', extra: seg2 },
  )
  return `<div class="vis-row" ${seg2}><span class="vis-label">Present</span>
          ${uiSelect}
          ${
            display
              ? `<input class="vis-num" type="number" min="1" max="60" data-action="seg-vis-display-secs" ${seg2} value="${secs}" title="Auto-hide seconds" />s
                 <input class="vis-text" type="text" maxlength="80" placeholder="auto: label value" data-action="seg-vis-display-text" ${seg2} value="${esc(display.text ?? '')}" />`
              : ''
          }
        </div>`
}

// segment 単位の表示タイミング条件エディタ (metric 行のサブ行)。対象は self または同 group 内の兄弟。
// 条件は素材 (SegMeta.visibility。profile 非依存) を読み書きする。
// leaf を AND/OR で複合。conditions 空 = 常時表示。2 件以上で combinator(All of/Any of) を出す。
function segVisEditor(key: string, sm: SegMeta): string {
  const seg2 = `data-key="${key}" data-seg="${esc(sm.id)}"`
  const ref = parseKey(key)
  const choices = segChoicesFor(ref)
  const groupHasPct = choices.some((c) => c.hasPct)
  const conditions = sm.visibility?.conditions ?? []
  const combinator = sm.visibility?.combinator ?? 'and'
  const head =
    conditions.length >= 2
      ? actionSelect(
          'seg-vis-combinator',
          [
            { value: 'and', label: 'All of', selected: combinator === 'and' },
            { value: 'or', label: 'Any of', selected: combinator === 'or' },
          ],
          { cls: 'vis-select', extra: seg2 },
        )
      : `<span class="vis-always">${conditions.length === 0 ? 'always' : 'when'}</span>`
  const rows = conditions.map((l, i) => leafRow(seg2, l, i, choices, sm.id, groupHasPct)).join('')
  const add =
    conditions.length < MAX_CONDS
      ? actionButton('seg-vis-add', `${icon('plus', { size: 13 })} Add condition`, {
          cls: 'vis-add',
          extra: seg2,
        })
      : ''
  const displayRow = segVisDisplayRow(seg2, sm, conditions.length)
  return `<div class="vis-row" ${seg2}><span class="vis-label">Show</span>${head}</div>
    <div class="vis-conds">${rows}${add}</div>${displayRow}`
}

// select 型の表示オプション 1 フィールド。
function optionSelectControl(
  a: string,
  f: Extract<OptionField, { kind: 'select' }>,
  values: OptionValues,
): string {
  const cur = String(values[f.id] ?? f.default)
  const opts = optionsHtml(f.choices.map((c) => ({ ...c, selected: c.value === cur })))
  return `<label class="clock-fld">${esc(f.label)}<select class="format-select" ${a} data-field="${esc(f.id)}" data-kind="select">${opts}</select></label>`
}

// toggle 型の表示オプション 1 フィールド。
function optionToggleControl(
  a: string,
  f: Extract<OptionField, { kind: 'toggle' }>,
  values: OptionValues,
): string {
  const raw = values[f.id]
  const on = typeof raw === 'boolean' ? raw : f.default
  return `<label class="clock-fld">${esc(f.label)}<button class="tg sm ${on ? 'on' : ''}" ${a} data-field="${esc(f.id)}" data-kind="toggle" data-val="${on ? '0' : '1'}"></button></label>`
}

// number 型の表示オプション 1 フィールド。
function optionNumberControl(
  a: string,
  f: Extract<OptionField, { kind: 'number' }>,
  values: OptionValues,
): string {
  const cur = Number(values[f.id] ?? f.default)
  const step = f.step ? `step="${f.step}"` : ''
  return `<label class="clock-fld">${esc(f.label)}<input class="vis-num" type="number" min="${f.min}" max="${f.max}" ${step} ${a} data-field="${esc(f.id)}" data-kind="number" value="${cur}" />${f.unit ? esc(f.unit) : ''}</label>`
}

// 表示オプション 1 フィールド (kind 別ディスパッチ)。
function optionFieldControl(a: string, f: OptionField, values: OptionValues): string {
  if (f.kind === 'select') return optionSelectControl(a, f, values)
  if (f.kind === 'toggle') return optionToggleControl(a, f, values)
  return optionNumberControl(a, f, values)
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
  return `<div class="clock-ctl">${fields.map((f) => optionFieldControl(a, f, values)).join('')}</div>`
}

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
