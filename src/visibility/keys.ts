// 表示条件の型と key 生成の純粋 leaf。他モジュールを import しない。
// conditions.ts(純粋コア)・config.ts(永続型)・glass-render.ts(描画) が共有する基盤。
// ここを leaf 化して config → visibility(barrel=index, runtime を re-export) の循環依存を断つ。

// leaf = 条件の最小単位。threshold は seg.percent を比較、onChange は seg.value 変化で holdMs 表示。
export type VisibilityLeaf =
  | { kind: 'threshold'; op: 'lte' | 'gte'; value: number }
  | { kind: 'onChange'; holdMs: number }

// 複合条件: leaf 列を単一 combinator(and/or) で結合。conditions 空 = 常時表示。
export type VisibilityCond = { combinator: 'and' | 'or'; conditions: VisibilityLeaf[] }

export type VisibleMap = Map<string, boolean> // key = "sourceId|groupId|segId"
export type OnChangeState = { prevValue: string; activeUntil: number }
export type VisStates = Map<string, OnChangeState> // key = `${segKey}#${leafIndex}`。onChange leaf のみ保持

export function segKey(sourceId: string, groupId: string, segId: string): string {
  return `${sourceId}|${groupId}|${segId}`
}
