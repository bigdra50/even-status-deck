// IMU 方向検出の Imperative Shell。imuControl のライフサイクル管理、サンプル供給、
// 方向イベントの購読レジストリを担う。純粋ロジックは orientation.ts。
// imuData はアプリ側アダプタ (glass.ts onEvent) から feedImuSample で供給される
// (別の onEvenHubEvent を張らず二重購読を避ける)。
//
// 前提: imuControl は createStartUpPageContainer 成功後でないと不可 (audio と同じ)。
import { type EvenAppBridge, ImuReportPace } from '@evenrealities/even_hub_sdk'
import type { ImuConfig } from './config'
import {
  type DetectorState,
  type DirectionEvent,
  initialDetectorState,
  step,
  type Vec3,
} from './orientation'

export type ImuConsumer = (e: DirectionEvent) => void

let cfg: ImuConfig | null = null
let detector: DetectorState = initialDetectorState()
let started = false
const consumers = new Set<ImuConsumer>()

export function setImuConfig(next: ImuConfig): void {
  cfg = next
}

export function isImuStarted(): boolean {
  return started
}

// 方向イベントの購読 API。返り値で解除する。consumer は e.direction / e.phase('enter'|'hold') を使う。
export function onDirectionChange(cb: ImuConsumer): () => void {
  consumers.add(cb)
  return () => {
    consumers.delete(cb)
  }
}

// pace コード (100..1000) を ImuReportPace へ解決する。不正値は P500 fallback。
function resolvePace(code: number): ImuReportPace {
  const key = `P${code}` as keyof typeof ImuReportPace
  return ImuReportPace[key] ?? ImuReportPace.P500
}

export async function startImu(bridge: EvenAppBridge, paceCode: number): Promise<void> {
  if (started) return
  detector = initialDetectorState()
  try {
    await bridge.imuControl(true, paceCode ? resolvePace(paceCode) : ImuReportPace.P500)
    started = true
  } catch {
    /* imuControl 失敗 (前提未充足/非対応) は無視。started=false のまま */
  }
}

export async function stopImu(bridge: EvenAppBridge): Promise<void> {
  detector = initialDetectorState()
  if (!started) return
  started = false
  try {
    await bridge.imuControl(false)
  } catch {
    /* 既に停止/不通は無視 */
  }
}

function notify(events: DirectionEvent[]): void {
  for (const e of events) for (const c of consumers) c(e)
}

// IMU 1 サンプルを供給する。step で状態を進め、方向イベントを購読者へ通知する。
export function feedImuSample(v: Vec3, now: number): void {
  if (!cfg) return
  const r = step(detector, v, now, cfg.axis, cfg.thresholds)
  detector = r.state
  if (r.events.length) notify(r.events)
}
