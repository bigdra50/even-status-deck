// companion の group/segment/source/place 行 HTML を組み立てる純 render 部品層。
// ctx(./state)・sync(./sync)・外部モジュールだけに依存し、index/debug-console は import しない (no-circular)。
import {
  activeView,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SEG_LABELS,
  BUILTIN_SOURCE_ID,
  customLabelKey,
  DEFAULT_PLACE_RADIUS_M,
  type GroupRef,
  groupDisplayName,
  type OptionValues,
  type Place,
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
import { ctx } from './state'
import { editingLayout, parseKey, statusGroup, visibleRefs, worstReportedState } from './sync'

// 1 segment が持てる条件 leaf の上限 (UI が破綻しない緩い上限)。
export const MAX_CONDS = 4
const DEFAULT_DISPLAY_SECS = 5 // 提示 (toast/notification) の既定 自動非表示秒数

// inPlace leaf の place select + inside/outside(#43)。
function leafInPlaceParams(a: string, leaf: Extract<VisibilityLeaf, { kind: 'inPlace' }>): string {
  const placeOpts = (ctx.config.places ?? [])
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
  const opts = list
    .map(
      (c) =>
        `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.label)}${selfId && c.id === selfId ? ' (this)' : ''}</option>`,
    )
    .join('')
  return `<select class="vis-select" data-action="seg-vis-leaf-seg" ${a}>${opts}</select>`
}

// leaf の params (kind 別)。threshold/onChange は対象 (self/兄弟) を選べる。present は兄弟必須。
function leafParams(
  a: string,
  leaf: VisibilityLeaf,
  choices: SegChoice[],
  sibs: SegChoice[],
  selfId: string,
): string {
  if (leaf.kind === 'inPlace') return leafInPlaceParams(a, leaf)
  if (leaf.kind === 'present') {
    const opts = sibs.length ? sibs : choices.filter((c) => c.id === leaf.seg)
    return `${targetSelect(a, opts, leaf.seg)}
      <select class="vis-select" data-action="seg-vis-leaf-absent" ${a}>
        <option value="present" ${leaf.absent ? '' : 'selected'}>has value</option>
        <option value="absent" ${leaf.absent ? 'selected' : ''}>is empty</option>
      </select>`
  }
  if (leaf.kind === 'threshold') {
    // 対象候補は percent を持つ segment (self/兄弟)。保存済み対象は targetSelect が補完する。
    const pctChoices = choices.filter((c) => c.hasPct)
    const tsel =
      pctChoices.length >= 2 || leaf.seg
        ? targetSelect(a, pctChoices, leaf.seg ?? selfId, selfId)
        : ''
    return `${tsel}<select class="vis-select" data-action="seg-vis-leaf-op" ${a}>
        <option value="gte" ${leaf.op === 'gte' ? 'selected' : ''}>≥</option>
        <option value="lte" ${leaf.op === 'lte' ? 'selected' : ''}>≤</option>
      </select>
      <input class="vis-num" type="number" min="0" max="100" data-action="seg-vis-leaf-value" ${a} value="${leaf.value}" />%`
  }
  // onChange: 兄弟があれば対象 select を出す (省略=self)。
  const tsel = choices.length >= 2 ? targetSelect(a, choices, leaf.seg ?? selfId, selfId) : ''
  return `${tsel}<input class="vis-num" type="number" min="1" max="60" data-action="seg-vis-leaf-hold" ${a} value="${Math.round(leaf.holdMs / 1000)}" />s`
}

// 1 leaf 行 (kind select + 対象/params + 削除ボタン)。threshold は同 group に percent を持つ segment が
// ある時のみ候補。present は対象に別 segment が要るので兄弟がある時のみ。既存 leaf は条件を満たさなくても
// 自分の kind を候補に残す (data 移行後の編集を壊さない)。inPlace(#43) は保存地点がある時。
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
  const allowInPlace = (ctx.config.places?.length ?? 0) > 0 || leaf.kind === 'inPlace'
  const allowPresent = sibs.length > 0 || leaf.kind === 'present'
  const kindSel = `<select class="vis-select" data-action="seg-vis-leaf-kind" ${a}>
    ${allowThreshold ? `<option value="threshold" ${leaf.kind === 'threshold' ? 'selected' : ''}>When…</option>` : ''}
    <option value="onChange" ${leaf.kind === 'onChange' ? 'selected' : ''}>On update</option>
    ${allowPresent ? `<option value="present" ${leaf.kind === 'present' ? 'selected' : ''}>Has value</option>` : ''}
    ${allowInPlace ? `<option value="inPlace" ${leaf.kind === 'inPlace' ? 'selected' : ''}>At place</option>` : ''}
  </select>`
  const params = leafParams(a, leaf, choices, sibs, selfId)
  const del = `<button class="vis-del" data-action="seg-vis-remove" ${a} title="Remove" aria-label="Remove">${icon('x', { size: 14 })}</button>`
  return `<div class="vis-cond-row">${kindSel}${params}${del}</div>`
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
      ? `<select class="vis-select" data-action="seg-vis-combinator" ${seg2}>
          <option value="and" ${combinator === 'and' ? 'selected' : ''}>All of</option>
          <option value="or" ${combinator === 'or' ? 'selected' : ''}>Any of</option>
        </select>`
      : `<span class="vis-always">${conditions.length === 0 ? 'always' : 'when'}</span>`
  const rows = conditions.map((l, i) => leafRow(seg2, l, i, choices, sm.id, groupHasPct)).join('')
  const add =
    conditions.length < MAX_CONDS
      ? `<button class="vis-add" data-action="seg-vis-add" ${seg2}>${icon('plus', { size: 13 })} Add condition</button>`
      : ''
  // 提示先。条件があるときのみ。Inline=現状の常時表示 / Toast・Notification は成立時に提示し自動非表示 (排他)。
  // toast/notification とも自動消去するので秒数フィールドを出す (既定 DEFAULT_DISPLAY_SECS)。
  const display = sm.visibility?.display
  const secs = display?.durationMs ? Math.round(display.durationMs / 1000) : DEFAULT_DISPLAY_SECS
  const displayRow =
    conditions.length === 0
      ? ''
      : `<div class="vis-row" ${seg2}><span class="vis-label">Present</span>
          <select class="vis-select" data-action="seg-vis-display-ui" ${seg2}>
            <option value="" ${!display ? 'selected' : ''}>Inline (persistent)</option>
            <option value="toast" ${display?.ui === 'toast' ? 'selected' : ''}>Toast</option>
            <option value="notification" ${display?.ui === 'notification' ? 'selected' : ''}>Notification</option>
          </select>
          ${
            display
              ? `<input class="vis-num" type="number" min="1" max="60" data-action="seg-vis-display-secs" ${seg2} value="${secs}" title="Auto-hide seconds" />s
                 <input class="vis-text" type="text" maxlength="80" placeholder="auto: label value" data-action="seg-vis-display-text" ${seg2} value="${esc(display.text ?? '')}" />`
              : ''
          }
        </div>`
  return `<div class="vis-row" ${seg2}><span class="vis-label">Show</span>${head}</div>
    <div class="vis-conds">${rows}${add}</div>${displayRow}`
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
  // segment の並びは素材 (meta.segments)、ON/OFF・条件は view/素材から引く。
  // source 単位の表示オプション (#36)。素材 = 全 profile 共有。スキーマが空なら描かない。
  // srcOpts は .src-metrics の「外」(直前) に出す。.src-metrics は SortableJS の segment 並べ替え
  // コンテナで、onSegReorder が e.oldIndex(= 全直接子の index) を meta.segments index として使うため、
  // 非 segment ノードを中に混ぜると index が +1 ずれて別 segment を動かす (silent なデータ破損)。
  const srcFields = sourceOptionSchema(ref.sourceId)
  const srcOpts = srcFields.length
    ? optionControls(key, '', 'source', srcFields, resolveSourceOptions(ctx.config, ref.sourceId))
    : ''
  const metrics = vg.expanded
    ? `${srcOpts}<div class="src-metrics" data-key="${key}">${meta.segments
        .map((sm) => {
          // Items は設定面なので、live status に未出現の segment も meta にあれば行を描く
          // (placeholder 値 '—')。トグル/並べ替え/配置/表示条件を事前設定できる。値は status のみ。
          const live = segById.get(sm.id)
          const seg: Segment = live ?? { id: sm.id, label: sm.displayLabel ?? '', value: '—' }
          const missing = !live
          const enabled = vg.segments[sm.id] ?? true
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
  // 同 source 内で同名の group は glass で 1 unit にマージされる。管理面は per-group なので
  // どの provider 由来か分かるよう group id を淡色併記する (衝突時のみ)。
  const gidTag = groupHeadingCollides(ref.sourceId, ref.groupId)
    ? `<span class="src-note">${esc(ref.groupId)}</span>`
    : ''
  // default-label トグル (glass で group 名を前置するか)。位置/上詰めは Glass layout で決める。
  const showsLabel = vg.showDefaultLabel ?? ref.groupId !== 'clock'
  const labelBtn = `<button class="label-btn ${showsLabel ? 'on' : ''}" data-action="toggle-grouplabel" data-key="${key}" title="${showsLabel ? 'Group label shown on glass' : 'Group label hidden'}">${icon('tag', { size: 15 })}</button>`
  // group 名のリネーム (Source Detail)。同 source 内で同名の group は glass で 1 unit にマージ表示される。
  const renameBtn = `<button class="label-btn" data-action="edit-groupname" data-key="${key}" title="Rename group" aria-label="Rename group">${icon('pencil', { size: 14 })}</button>`
  // owner は Source Detail ヘッダで編集 / glass picker でバッジ表示する (表示モデル新 IA)。group 行には出さない。
  return `<div class="src" data-key="${key}"><div class="src-head"><span class="src-grip">${icon('grip', { size: 16 })}</span>
    <span class="src-caret" data-action="expand" data-key="${key}">${caret}</span>
    <span class="src-name" data-action="expand" data-key="${key}">${esc(title)}</span>
    ${gidTag}
    ${srcTag}
    ${renameBtn}
    ${labelBtn}
    <button class="tg ${vg.enabled ? 'on' : ''}" data-action="toggle-group" data-key="${key}"></button></div>${metrics}</div>`
}

// 1 source の group 行群 (Source Detail 用)。group の横断並べ替えは Glass Layout が持つので
// ここでは #source-list を使わず (group sortable を張らない)、segment 並べ替え (.src-metrics) のみ効く。
export function renderSourceGroups(sourceId: string): string {
  const refs = visibleRefs().filter((r) => r.sourceId === sourceId)
  if (!refs.length) return '<div class="cmp-sub">No data from this source yet.</div>'
  return refs.map((r) => groupRow(r)).join('')
}

// ── source 行 (3 文脈: Home=preset 内 / Sources 一覧 / preset へ追加) ──
// 接続状態 dot と note (online=緑 / stale=琥珀 / offline=灰+"Last seen…")。
// transport が online でもソースが degraded を報告していれば琥珀 + message を出す (2 軸)。
export function sourceDotNote(s: SourceDef): { dotCls: string; note: string } {
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
  const bg = `<div class="swipe-bg"><button class="swipe-del" data-action="remove-from-preset" data-src="${esc(s.id)}" aria-label="Remove from preset" title="Remove from preset">${icon('trash', { size: 18 })}</button></div>`
  return `<div class="src swipe-row" data-src="${esc(s.id)}" data-swipeable="1">${bg}${fg}</div>`
}

// Sources 一覧: 全 source 実体の管理。編集 (URL/machineId/削除) へ。
export function sourceManageRow(s: SourceDef): string {
  const { dotCls, note } = sourceDotNote(s)
  return `<div class="src"><div class="src-head"><span class="conn-dot ${dotCls}"></span>
    <span class="src-name">${esc(s.label)}</span>
    <span class="src-note">${esc(note)}</span>
    <button class="gear-btn" data-action="edit-source" data-src="${esc(s.id)}" title="Edit" aria-label="Edit">${icon('settings', { size: 18 })}</button></div></div>`
}

// preset への追加候補: まだこの preset に無い source。タップで preset へ追加。
export function sourceAddRow(s: SourceDef): string {
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

// ── 保存地点管理 (#43 geofence) ──
// 各保存地点を name + 座標 + 半径 + 削除で並べ、現在地を新規保存できる。保存地点は geofence
// (preset 自動切替/提案・inPlace 表示条件)の領域定義に使う。距離/方位ナビ表示(#42)は撤廃済。
export function placeManageRow(p: Place): string {
  const radius = p.radiusM ?? DEFAULT_PLACE_RADIUS_M
  return `<div class="src"><div class="src-head">
    <span class="src-name">${esc(p.label)}</span>
    <span class="src-note mono">${p.lat.toFixed(3)}, ${p.lon.toFixed(3)} · ${radius}m</span>
    <button class="link-btn" data-action="rename-place" data-place="${esc(p.id)}" title="Rename">Rename</button>
    <button class="link-btn" data-action="radius-place" data-place="${esc(p.id)}" title="Geofence radius">Radius</button>
    <button class="link-btn" data-action="delete-place" data-place="${esc(p.id)}" title="Delete">Delete</button></div></div>`
}
