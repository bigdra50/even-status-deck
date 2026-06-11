// group/segment 行 (Source Detail) の click ハンドラ: 表示トグル・owner/group 名リネーム・
// 表示条件 (seg-vis-*) の追加削除・表示オプション toggle (opt-set)。
// actions.ts の CLICK_ACTIONS に合流する。state/render-port/sync/rows-visibility/conditions-ui と config に依存。
import {
  activeView,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  saveConfig,
  sourceById,
} from '../config'
import { effectiveOwner, normalizeHeading } from '../display-identity'
import { applyOptionChange } from './conditions-ui'
import { requestRender } from './render-port'
import { MAX_CONDS } from './rows-visibility'
import { ctx } from './state'
import { applyDisplayLabels, parseKey, statusGroup } from './sync'

type ClickHandler = (t: HTMLElement, e: MouseEvent) => void | Promise<void>

// headingCollidesInSomeProfile は rows.ts (group 見出し衝突判定) を参照する。
// 循環 import を避けるため、呼び出しは関数経由で受け取る (composeClickActions から渡す)。
type HeadingCollideFn = (sourceId: string, groupId: string, headingKey: string) => string | null

function confirmHeadingMerge(
  headingCollidesInSomeProfile: HeadingCollideFn,
  sourceId: string,
  groupId: string,
  nextHeading: string,
): boolean {
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
  headingCollidesInSomeProfile: HeadingCollideFn,
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
  if (!confirmHeadingMerge(headingCollidesInSomeProfile, ref.sourceId, ref.groupId, nextHeading)) {
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

// CLICK_ACTIONS への合流は composeClickActions (actions.ts) から行い、headingCollidesInSomeProfile
// (rows.ts) を引数で渡す (rows.ts → actions-groups.ts の循環 import を避ける)。
export function groupClickActions(
  headingCollidesInSomeProfile: HeadingCollideFn,
): Record<string, ClickHandler> {
  return {
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
          commitGroupNameRename(
            headingCollidesInSomeProfile,
            ref,
            meta,
            next.trim(),
            base,
            isBuiltin,
          )
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
            hasPct
              ? { kind: 'threshold', op: 'gte', value: 80 }
              : { kind: 'onChange', holdMs: 5000 },
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
  }
}
