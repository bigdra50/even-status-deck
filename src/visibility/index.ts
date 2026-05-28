// 表示タイミング条件ライブラリの公開 API。
//
// 構成:
//   conditions.ts  純粋コア   VisibilityLeaf/VisibilityCond/VisibleMap/VisStates、
//                             computeVisibleMap/isVisible/segKey/defaultVisibilityCond
//   runtime.ts     Shell      computeVisible (transient 状態 + 窓終了タイマー保持) / resetVisibility
//
// shell(glass.ts / companion.ts) が computeVisible(config, statuses) で visibleMap(segment 粒度) を算出し、
// pure render(glass-render.ts) へ引数で渡す。条件は segment 単位
// config.groups[*][*].segments[*].visibility に永続 (leaf の AND/OR 複合)。

export type {
  OnChangeState,
  VisibilityCond,
  VisibilityLeaf,
  VisibleMap,
  VisStates,
} from './conditions'
export { computeVisibleMap, defaultVisibilityCond, isVisible, segKey } from './conditions'
export { computeVisible, resetVisibility } from './runtime'
