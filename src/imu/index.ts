// IMU 方向検出ライブラリの公開 API。
//
// 使い方 (将来の consumer 例: 「上下を向いたら n 秒表示」):
//   import { onDirectionChange, type DirectionEvent } from './imu'
//   // config.imu.enabled=true にすると glass アダプタが startImu → feedImuSample で供給する。
//   const off = onDirectionChange((e: DirectionEvent) => {
//     if (e.phase === 'enter' && e.direction === 'up') { /* ... */ }
//   })
//
// アプリ側アダプタ (glass.ts) が bridge→feedImuSample の配線と config 駆動 start/stop を担う。
// 純粋コア (classify/step/anglesOf) はテスト・再利用向けに公開している。

export type { ImuConfig } from './config'
export { defaultImuConfig } from './config'
export type { ImuConsumer } from './controller'
export {
  feedImuSample,
  isImuStarted,
  onDirectionChange,
  setImuConfig,
  startImu,
  stopImu,
} from './controller'
export type {
  AxisConfig,
  DetectorState,
  Direction,
  DirectionEvent,
  Sign,
  Thresholds,
  Vec3,
} from './orientation'
export { anglesOf, classify, initialDetectorState, step } from './orientation'
