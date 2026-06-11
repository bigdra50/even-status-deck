// segment 単位の表示タイミング条件 (SegMeta.visibility) エディタ UI 断片。rows.ts から分離。
// ctx(./state)・sync(./sync)・外部モジュールだけに依存し、index/debug-console は import しない (no-circular)。
import { BUILTIN_SEG_LABELS, BUILTIN_SOURCE_ID, type GroupRef, type SegMeta } from '../config'
import { esc } from '../escape'
import { icon } from '../icons'
import type { VisibilityLeaf } from '../visibility'
import { actionButton, actionSelect, type SelectOption } from './html'
import { ctx } from './state'
import { parseKey, statusGroup } from './sync'

// 1 segment が持てる条件 leaf の上限 (UI が破綻しない緩い上限)。
export const MAX_CONDS = 4
const DEFAULT_DISPLAY_SECS = 5 // 提示 (toast/notification) の既定 自動非表示秒数

// 表示条件の対象 segment 候補 (同 group 内)。label は表示用、hasPct は live で percent を持つか
// (threshold 候補の判定に使う)。母集合は素材 (meta.segments)、percent は live status から補う。
export type SegChoice = { id: string; label: string; hasPct: boolean }
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
export function segVisEditor(key: string, sm: SegMeta): string {
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
