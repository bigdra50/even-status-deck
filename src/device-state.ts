// グラス (G2) のバッテリー状態を保持する共有ストア。glass.ts が bridge から書き込み、
// glass-render (グラス HUD) と companion (プレビュー HUD) が読む。
// SDK の getDeviceInfo は単一デバイスのみ、phone battery は非対応のため G2 のみ扱う。
let level: number | null = null
let charging = false

export function setGlassBattery(lv: number | null, chg: boolean): void {
  level = lv
  charging = chg
}

export function getGlassBattery(): { level: number | null; charging: boolean } {
  return { level, charging }
}
