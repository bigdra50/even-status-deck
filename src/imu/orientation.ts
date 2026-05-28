// IMU 姿勢分類の純粋コア (bridge 非依存)。重力ベクトル(加速度)前提で pitch/roll を算出し、
// 上下左右正面に分類する。EMA で平滑化し、同一方向の継続 (hold) を状態機械で検出する。
// imuData の軸の向き・スケールは SDK 未定義のため、軸マッピング(AxisConfig)としきい値を
// 外から与えてキャリブレーション可能にしている。
//
// 既知の限界: yaw (左右に首を水平に振る) は重力ベクトルからは原理的に検出できない。
// 「左右」は首かしげ(roll)として扱う。

export type Vec3 = { x: number; y: number; z: number }
export type Direction = 'forward' | 'up' | 'down' | 'left' | 'right' | 'unknown'
export type Axis = 'x' | 'y' | 'z'
export type Sign = 1 | -1

// 重力ベクトル前提の軸マッピング。直立・正面時に重力が gravityFrom 軸へ正で乗る想定。
// pitch (上下うなずき) / roll (左右かしげ) に使う軸と符号を指定する。
export type AxisConfig = {
  gravityFrom: Axis
  gravitySign: Sign
  pitchFrom: Axis
  pitchSign: Sign
  rollFrom: Axis
  rollSign: Sign
}

// 角度しきい値 (deg) と hold/平滑の設定。
// 規約: pitchDeg>0 → up / <0 → down、rollDeg>0 → right / <0 → left (符号は AxisConfig で反転調整)。
// pitch/rollOffsetDeg: 「正面(rest)」での pitch/roll。グラスは装着時に傾くため正面≠水平。
// classify 前にこのオフセットを引き、正面を 0 とした相対角で分類する。
export type Thresholds = {
  pitchOffsetDeg: number // 正面(rest)の pitch。減算して正面を 0 に正規化
  rollOffsetDeg: number // 正面(rest)の roll
  pitchUpDeg: number // (相対) これ以上で up
  pitchDownDeg: number // (相対) これ以下で down (負値)
  rollDeg: number // (相対) |roll| これ以上で left/right
  forwardDeg: number // pitch/roll 共に |.| 未満なら forward (デッドバンド)
  holdMs: number // 同一方向を維持で hold とみなす
  emaAlpha: number // 0..1 EMA 係数 (大きいほど追従が速くノイズに敏感)
}

export type DetectorState = {
  ema: Vec3 | null
  direction: Direction
  since: number // 現 direction に入った時刻
  held: boolean // holdMs 経過済みか (hold イベント重複防止)
}

export type DirectionEvent = {
  direction: Direction
  phase: 'enter' | 'hold' // enter=向いた瞬間 / hold=向き続けた (holdMs 経過)
  pitchDeg: number
  rollDeg: number
  at: number
}

export type StepResult = {
  state: DetectorState
  events: DirectionEvent[]
  pitchDeg: number
  rollDeg: number
  direction: Direction
}

const RAD2DEG = 180 / Math.PI

export function initialDetectorState(): DetectorState {
  return { ema: null, direction: 'unknown', since: 0, held: false }
}

function axisValue(v: Vec3, axis: Axis, sign: Sign): number {
  return v[axis] * sign
}

// 重力ベクトルから pitch/roll を航空姿勢の tilt 公式で算出する。
export function anglesOf(v: Vec3, axis: AxisConfig): { pitchDeg: number; rollDeg: number } {
  const g = axisValue(v, axis.gravityFrom, axis.gravitySign)
  const p = axisValue(v, axis.pitchFrom, axis.pitchSign)
  const r = axisValue(v, axis.rollFrom, axis.rollSign)
  const pitchDeg = Math.atan2(p, Math.hypot(r, g)) * RAD2DEG
  const rollDeg = Math.atan2(r, g) * RAD2DEG
  return { pitchDeg, rollDeg }
}

function classifyAngles(pitchDeg: number, rollDeg: number, th: Thresholds): Direction {
  const absPitch = Math.abs(pitchDeg)
  const absRoll = Math.abs(rollDeg)
  if (absPitch < th.forwardDeg && absRoll < th.forwardDeg) return 'forward'

  const overPitch = pitchDeg >= th.pitchUpDeg || pitchDeg <= th.pitchDownDeg
  const overRoll = absRoll >= th.rollDeg
  // pitch / roll が両方超えたら絶対値の大きい方を採用 (支配的な動きを選ぶ)。
  if (overPitch && (!overRoll || absPitch >= absRoll)) {
    return pitchDeg >= th.pitchUpDeg ? 'up' : 'down'
  }
  if (overRoll) return rollDeg >= th.rollDeg ? 'right' : 'left'
  return 'unknown' // デッドバンドと閾値の間 (ヒステリシス的余白)
}

// 返す pitchDeg/rollDeg は正面オフセットを引いた相対角 (正面 ≒ 0)。分類もこの相対角で行う。
export function classify(
  v: Vec3,
  axis: AxisConfig,
  th: Thresholds,
): { pitchDeg: number; rollDeg: number; direction: Direction } {
  const abs = anglesOf(v, axis)
  const pitchDeg = abs.pitchDeg - th.pitchOffsetDeg
  const rollDeg = abs.rollDeg - th.rollOffsetDeg
  return { pitchDeg, rollDeg, direction: classifyAngles(pitchDeg, rollDeg, th) }
}

function smooth(prev: Vec3 | null, v: Vec3, alpha: number): Vec3 {
  if (!prev) return { x: v.x, y: v.y, z: v.z }
  return {
    x: prev.x + (v.x - prev.x) * alpha,
    y: prev.y + (v.y - prev.y) * alpha,
    z: prev.z + (v.z - prev.z) * alpha,
  }
}

// 1 サンプル分の状態遷移。direction が変わったら enter、同一方向が holdMs 継続したら一度だけ hold を emit。
export function step(
  s: DetectorState,
  v: Vec3,
  now: number,
  axis: AxisConfig,
  th: Thresholds,
): StepResult {
  const ema = smooth(s.ema, v, th.emaAlpha)
  const { pitchDeg, rollDeg, direction } = classify(ema, axis, th)
  const events: DirectionEvent[] = []

  let nextDir = s.direction
  let since = s.since
  let held = s.held

  if (direction !== s.direction) {
    nextDir = direction
    since = now
    held = false
    if (direction !== 'unknown') {
      events.push({ direction, phase: 'enter', pitchDeg, rollDeg, at: now })
    }
  } else if (!held && direction !== 'unknown' && now - since >= th.holdMs) {
    held = true
    events.push({ direction, phase: 'hold', pitchDeg, rollDeg, at: now })
  }

  return {
    state: { ema, direction: nextDir, since, held },
    events,
    pitchDeg,
    rollDeg,
    direction,
  }
}
