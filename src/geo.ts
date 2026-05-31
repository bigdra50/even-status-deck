// 地点ナビ(#42)の純粋な地理計算。保存地点までの大円距離・方位を求め、ASCII で整形する。
// glass の値は ASCII のみ(° や絵文字は実機 tofu)。方位の矢印グリフは opt-in(実機フォント未検証)。

const EARTH_R_KM = 6371

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

// 2 点間の大円距離(km)。haversine。
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

// from→to の初期方位(度, 0=北, 時計回り)。
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = toRad(lon2 - lon1)
  const y = Math.sin(dLon) * Math.cos(toRad(lat2))
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

const DIRS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const DIRS16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
]
// 8 方位の絶対方位を表す矢印グリフ(N=↑ 時計回り)。頭の向き連動ではなく絶対方位の図示。
const ARROWS8 = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖']

function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360
}

// 度 → 8 方位テキスト(N/NE/…)。
export function compass8(deg: number): string {
  return DIRS8[Math.round(norm360(deg) / 45) % 8]
}

// 度 → 16 方位テキスト(N/NNE/…)。
export function compass16(deg: number): string {
  return DIRS16[Math.round(norm360(deg) / 22.5) % 16]
}

// 度 → 絶対方位の矢印グリフ(opt-in。実機フォントに矢印が無いと tofu)。
export function bearingArrow(deg: number): string {
  return ARROWS8[Math.round(norm360(deg) / 45) % 8]
}

export type BearingStyle = 'text' | 'arrow' | 'compass16'

// 方位スタイルに応じて方位を文字列化する。
export function formatBearing(deg: number, style: BearingStyle): string {
  if (style === 'arrow') return bearingArrow(deg)
  if (style === 'compass16') return compass16(deg)
  return compass8(deg)
}

export type DistanceUnit = 'km' | 'mi'

// 距離(km)を単位付き ASCII へ。近距離は m/小数、遠距離は整数で桁を抑える。
export function formatDistance(km: number, unit: DistanceUnit): string {
  if (unit === 'mi') {
    const mi = km * 0.621371
    if (mi < 0.1) return `${Math.round(mi * 5280)}ft`
    if (mi < 10) return `${mi.toFixed(1)}mi`
    return `${Math.round(mi)}mi`
  }
  if (km < 1) return `${Math.round(km * 1000)}m`
  if (km < 10) return `${km.toFixed(1)}km`
  return `${Math.round(km)}km`
}
