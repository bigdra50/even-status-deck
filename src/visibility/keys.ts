// 表示条件の型と key 生成の純粋 leaf。他モジュールを import しない。
// conditions.ts(純粋コア)・config.ts(永続型)・glass-render.ts(描画) が共有する基盤。
// ここを leaf 化して config → visibility(barrel=index, runtime を re-export) の循環依存を断つ。

// leaf = 条件の最小単位。threshold は seg.percent を比較、onChange は seg.value 変化で holdMs 表示。
// inPlace(#43) は現在地が保存地点(placeId)のジオフェンス圏内か(outside=圏外か)で判定。位置不明は na。
// threshold/onChange の seg? = 評価対象 (同 group 内の兄弟 segment id)。省略時は self (後方互換)。
// present は同 group 内の別 segment が値を持つか(absent=空か)。peer 専用 (self 存在は自明)。
export type VisibilityLeaf =
  | { kind: 'threshold'; op: 'lte' | 'gte'; value: number; seg?: string }
  | { kind: 'onChange'; holdMs: number; seg?: string }
  | { kind: 'inPlace'; placeId: string; outside?: boolean }
  | { kind: 'present'; seg: string; absent?: boolean }

// 提示先 UI。条件成立時に inline 常時表示でなく、選んだ overlay UI で出す (display 指定時)。
//   toast/notification/dialog = edge(成立の瞬間に 1 回) / banner = level(成立中ずっと上行表示)
export type DisplayUi = 'toast' | 'banner' | 'notification' | 'dialog'
// text 省略 = glass が live status から自動合成 ("label value")。指定 = カスタム文言。
export type CondDisplay = { ui: DisplayUi; text?: string }

// 複合条件: leaf 列を単一 combinator(and/or) で結合。conditions 空 = 常時表示。
// display 指定時は inline を出さず (排他)、成立を選んだ UI で提示する。
export type VisibilityCond = {
  combinator: 'and' | 'or'
  conditions: VisibilityLeaf[]
  display?: CondDisplay
}

export type VisibleMap = Map<string, boolean> // key = "sourceId|groupId|segId"
// 通知発火用の確定真偽。fail-open(inline 表示)とは別: na は unknown とし発火させない。
export type ConditionTruth = boolean | 'unknown'
export type ConditionTruthMap = Map<string, ConditionTruth> // 条件付き segment の strict 評価結果
export type OnChangeState = { prevValue: string; activeUntil: number }
export type VisStates = Map<string, OnChangeState> // key = `${segKey}#${leafIndex}`。onChange leaf のみ保持

export function segKey(sourceId: string, groupId: string, segId: string): string {
  return `${sourceId}|${groupId}|${segId}`
}
