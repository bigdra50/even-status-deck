// IMU 方向検出の設定。アクション未定の基盤機能のため既定 OFF。
// axis/thresholds は実測キャリブレーション値 (up/down/forward は確定、left/right は provisional)。
import type { AxisConfig, Thresholds } from './orientation'

export type ImuConfig = {
  enabled: boolean
  pace: number // ImuReportPace コード (100..1000、step 100)
  axis: AxisConfig
  thresholds: Thresholds
}

export function defaultImuConfig(): ImuConfig {
  return {
    enabled: false,
    pace: 500,
    // 実測 (imu-log 分析): 重力=z(+)、pitch=x(up→x↑)、roll=y。
    axis: {
      gravityFrom: 'z',
      gravitySign: 1,
      pitchFrom: 'x',
      pitchSign: 1,
      rollFrom: 'y',
      rollSign: 1,
    },
    thresholds: {
      // forward を 0 に正規化。up≈+19° / down≈-27° を捕捉。
      pitchOffsetDeg: -3,
      rollOffsetDeg: -5.4,
      pitchUpDeg: 10,
      pitchDownDeg: -13,
      rollDeg: 15, // provisional: left/right は roll 再キャプチャ未了 (yaw では検出不可)
      forwardDeg: 6,
      holdMs: 800,
      emaAlpha: 0.3,
    },
  }
}
