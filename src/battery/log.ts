// 電池消耗レートの Imperative Shell。G2 電池の level 変化イベントを bridge.setLocalStorage に
// 永続し、純粋コア (rate.ts) でレートを算出してキャッシュする。builtins が getBatteryDrainRate で読み、
// drain/est segment に整形する。glass / companion は同一ランタイムの singleton として本モジュールを共有する。
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { appendBatteryEvent, type BatteryEvent, computeDrainRate, type DrainRate } from './rate'

const KEY = 'toolbar.batteryLog'
const MAX_EVENTS = 64

let bridge: EvenAppBridge | null = null
let ring: BatteryEvent[] = []
let cached: DrainRate | null = null

export function setBatteryBridge(b: EvenAppBridge): void {
  bridge = b
}

// 永続ログを復元する (bridge 接続後)。不正データは捨て、空ログから開始する。
export async function loadBatteryLog(): Promise<void> {
  if (!bridge) return
  try {
    const raw = await bridge.getLocalStorage(KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return
    ring = parsed.filter(
      (e): e is BatteryEvent =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as BatteryEvent).level === 'number' &&
        typeof (e as BatteryEvent).ts === 'number',
    )
    cached = computeDrainRate(ring, ring[ring.length - 1]?.level ?? 0)
  } catch {
    /* 不正/不在は無視 */
  }
}

// G2 電池 level を記録する。level 変化時のみ ring へ追記し、レートを再算出・永続する。
export function recordBatteryLevel(level: number, charging: boolean, ts: number): void {
  const next = appendBatteryEvent(ring, { level, ts }, MAX_EVENTS)
  if (next === ring) return // 変化なし (同 level) は何もしない
  ring = next
  cached = charging ? null : computeDrainRate(ring, level)
  if (bridge) void bridge.setLocalStorage(KEY, JSON.stringify(ring)).catch(() => {})
}

// builtins が drain/est segment に整形する元データ。充電中は null (cached とは独立に live でゲート)。
// 充電判定は描画時の現在値を渡す。データ不足時も cached が null。
export function getBatteryDrainRate(charging: boolean): DrainRate | null {
  return charging ? null : cached
}
