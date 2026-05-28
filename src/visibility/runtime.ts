// 表示タイミング条件の Imperative Shell (singleton)。onChange の transient 状態 (前回値/活性期限) と
// 窓終了の再描画タイマーを保持する。純粋ロジックは conditions.ts (computeVisibleMap)。
// glass / companion がストア更新ごとに computeVisible を呼ぶ。多重呼び出しは冪等
// (2 回目以降は prevValue 更新済みで再検出されず、絶対時刻 activeUntil なので同じ map を返す)。
import type { Config } from '../config'
import type { StatusDoc } from '../status-types'
import { pokeListeners } from '../store'
import { computeVisibleMap, type VisibleMap, type VisStates } from './conditions'

let states: VisStates = new Map()
let wakeTimer: ReturnType<typeof setTimeout> | null = null

export function computeVisible(
  config: Config,
  statuses: Record<string, StatusDoc | null>,
  now: number = Date.now(),
): VisibleMap {
  const r = computeVisibleMap(config, statuses, states, now)
  states = r.states
  if (wakeTimer) {
    clearTimeout(wakeTimer)
    wakeTimer = null
  }
  // 活性窓の終了時刻に再描画を予約する (onChange group を hide させる)。絶対時刻基準なので再設定しても発火時刻は不変。
  if (r.wakeAt != null) {
    wakeTimer = setTimeout(
      () => {
        wakeTimer = null
        pokeListeners()
      },
      Math.max(0, r.wakeAt - now),
    )
  }
  return r.map
}

// cleanup 用: transient 状態とタイマーを破棄する。
export function resetVisibility(): void {
  states = new Map()
  if (wakeTimer) {
    clearTimeout(wakeTimer)
    wakeTimer = null
  }
}
