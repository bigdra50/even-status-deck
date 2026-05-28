// 電池消耗レートライブラリの公開 API。
//
// 構成:
//   rate.ts  純粋コア   appendBatteryEvent / computeDrainRate / formatRate / formatEta + 型
//   log.ts   Shell      setBatteryBridge / loadBatteryLog / recordBatteryLevel / getBatteryDrainRate
//                       (bridge 永続 + cached)
//
// glass.ts が bridge から level を recordBatteryLevel し、builtins.ts が getBatteryDrainRate を
// formatRate/formatEta で整形して HUD の drain/est segment にする。

export {
  getBatteryDrainRate,
  loadBatteryLog,
  recordBatteryLevel,
  setBatteryBridge,
} from './log'
export type { BatteryEvent, DrainRate } from './rate'
export {
  appendBatteryEvent,
  computeDrainRate,
  formatEta,
  formatRate,
} from './rate'
