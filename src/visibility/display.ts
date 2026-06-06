// 条件成立 → overlay UI 提示の Imperative Shell (glass 専用)。companion preview は使わない。
//
// 発火モデル: toast / notification とも edge。条件 truth が known-false → known-true の瞬間に 1 回発火し、
// overlay 側で durationMs 後に自動非表示する。banner(level)/dialog(選択肢) は条件提示では扱わない。
//
// 正しさのための規約 (codex GPT-5.5 と確定):
//   - 発火判定は truthMap (strict tri-state)。fail-open の VisibleMap は使わない (na で誤発火するため)。
//   - unknown (offline/評価不能) は edge を再アームしない & 前回 known 値を温存する (再接続で誤再発火しない)。
//   - seed(init/config 変更) は edge を発火させない (起動時の通知ストーム防止)。
//   - prev 未観測(undefined) は arm のみ (起動/接続直後に既に true でも撃たない = storm 防止)。
//   - per-key cooldown で連発を抑える。発火数の上限は持たない (overlay queue 上限が表示量を律速)。
//   - 対象は enabled な source/group/segment のみ。
//   - 文言は glass shell が live status から解決する (collector は segRef を返すだけ)。
import { activeView, BUILTIN_SOURCE_ID, type Config, enabledSources } from '../config'
import { type ConditionTruth, type ConditionTruthMap, type DisplayUi, segKey } from './keys'

const EDGE_COOLDOWN_MS = 30_000 // 同一 key の最小再発火間隔

export type DisplayFire = {
  ui: DisplayUi // 'toast' | 'notification'
  sourceId: string
  groupId: string
  segId: string
  text?: string // カスタム文言 (config.display.text)。省略時は glass が "label value" を自動合成
  durationMs?: number // 自動非表示までの ms (config.display.durationMs)。省略時は glass の既定
}
export type DisplayResult = { fires: DisplayFire[] }

export type ConditionDisplayRuntime = {
  // init / config 変更時。edge を発火させずに状態を seed する。
  seed(config: Config, truthMap: ConditionTruthMap): DisplayResult
  // store 更新時。edge 発火を算出する。
  observe(config: Config, truthMap: ConditionTruthMap, now?: number): DisplayResult
  // cleanup 用。全状態を破棄する。
  reset(): void
}

type Candidate = {
  key: string
  sourceId: string
  groupId: string
  segId: string
  ui: DisplayUi
  text?: string
  durationMs?: number
  truth: ConditionTruth
}

// active view 順に display 指定の候補を集める (enabled のみ)。
function collectDisplayCandidates(config: Config, truthMap: ConditionTruthMap): Candidate[] {
  const view = activeView(config)
  const enabledSrc = new Set(enabledSources(config).map((s) => s.id))
  const out: Candidate[] = []
  for (const ref of view.groupOrder) {
    if (ref.sourceId !== BUILTIN_SOURCE_ID && !enabledSrc.has(ref.sourceId)) continue
    const vg = view.groups[ref.sourceId]?.[ref.groupId]
    if (!vg?.enabled) continue
    const meta = config.groups[ref.sourceId]?.[ref.groupId]
    if (!meta) continue
    for (const sm of meta.segments) {
      const disp = sm.visibility?.display
      if (!disp) continue
      if (vg.segments[sm.id] === false) continue // segment 無効
      const key = segKey(ref.sourceId, ref.groupId, sm.id)
      out.push({
        key,
        sourceId: ref.sourceId,
        groupId: ref.groupId,
        segId: sm.id,
        ui: disp.ui,
        text: disp.text,
        durationMs: disp.durationMs,
        truth: truthMap.get(key) ?? 'unknown',
      })
    }
  }
  return out
}

export function createConditionDisplayRuntime(): ConditionDisplayRuntime {
  const edgeState = new Map<string, boolean>() // 最後に観測した known truth。unknown では更新しない (温存)
  const lastFiredAt = new Map<string, number>() // key -> 最終発火時刻 (cooldown)

  function evaluate(
    config: Config,
    truthMap: ConditionTruthMap,
    now: number,
    fire: boolean,
  ): DisplayResult {
    const cands = collectDisplayCandidates(config, truthMap)
    const fires: DisplayFire[] = []
    for (const c of cands) {
      if (c.truth === 'unknown') continue // 温存: edgeState を触らない・発火しない
      const prev = edgeState.get(c.key)
      // strict: 確定 false → 確定 true のみ。prev 未観測(undefined)は arm のみ (storm 防止)。
      const rising = prev === false && c.truth === true
      if (fire && rising) {
        const last = lastFiredAt.get(c.key) ?? Number.NEGATIVE_INFINITY
        if (now - last >= EDGE_COOLDOWN_MS) {
          fires.push({
            ui: c.ui,
            sourceId: c.sourceId,
            groupId: c.groupId,
            segId: c.segId,
            text: c.text,
            durationMs: c.durationMs,
          })
          lastFiredAt.set(c.key, now)
        }
      }
      edgeState.set(c.key, c.truth) // seed/observe 共通で known 値を記録
    }
    return { fires }
  }

  return {
    seed: (config, truthMap) => evaluate(config, truthMap, 0, false),
    observe: (config, truthMap, now = Date.now()) => evaluate(config, truthMap, now, true),
    reset: () => {
      edgeState.clear()
      lastFiredAt.clear()
    },
  }
}
