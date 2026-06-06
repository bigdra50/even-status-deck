// 表示タイミング条件の Imperative Shell。onChange の transient 状態 (前回値/活性期限) と
// 窓終了の再描画タイマーを instance ごとに保持する。純粋ロジックは conditions.ts (computeVisibleMap)。
//
// instance 化の理由: glass と companion preview は同一 SPA で共存し (main.ts が両方 mount)、
// どちらも compute を呼ぶ。singleton state を共有すると preview が onChange/edge 状態を先に
// 消費し glass が rising edge を取りこぼす。runtime を分けて state/timer を独立させる。
//   - glass:   createVisibilityRuntime({ wake: true })  (窓終了タイマーで再描画)
//   - preview: createVisibilityRuntime({ wake: false }) (タイマー不要・store 更新で再評価)
import type { Config } from '../config'
import { getInsidePlaceIds } from '../places'
import type { StatusDoc } from '../status-types'
import { pokeListeners } from '../store'
import { computeVisibleMap } from './conditions'
import type { ConditionTruthMap, VisibleMap, VisStates } from './keys'

export type VisibilityComputeResult = { map: VisibleMap; truthMap: ConditionTruthMap }

export type VisibilityRuntime = {
  // 可視 map (inline 表示) と truthMap (発火判定) を算出する。transient 状態は instance が保持。
  compute(
    config: Config,
    statuses: Record<string, StatusDoc | null>,
    now?: number,
  ): VisibilityComputeResult
  // transient 状態とタイマーを破棄する (cleanup 用)。
  reset(): void
}

export function createVisibilityRuntime(opts: { wake?: boolean } = {}): VisibilityRuntime {
  const wake = opts.wake !== false
  let states: VisStates = new Map()
  let wakeTimer: ReturnType<typeof setTimeout> | null = null

  function compute(
    config: Config,
    statuses: Record<string, StatusDoc | null>,
    now: number = Date.now(),
  ): VisibilityComputeResult {
    const r = computeVisibleMap(config, statuses, states, now, getInsidePlaceIds())
    states = r.states
    if (wake) {
      if (wakeTimer) {
        clearTimeout(wakeTimer)
        wakeTimer = null
      }
      // 活性窓の終了時刻に再描画を予約する (onChange group を hide させる)。
      // 絶対時刻基準なので再設定しても発火時刻は不変。
      if (r.wakeAt != null) {
        wakeTimer = setTimeout(
          () => {
            wakeTimer = null
            pokeListeners()
          },
          Math.max(0, r.wakeAt - now),
        )
      }
    }
    return { map: r.map, truthMap: r.truthMap }
  }

  function reset(): void {
    states = new Map()
    if (wakeTimer) {
      clearTimeout(wakeTimer)
      wakeTimer = null
    }
  }

  return { compute, reset }
}
