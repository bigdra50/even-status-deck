// G2 電池の消耗レート算出 (純粋コア)。level 変化イベント列から直近の単調減少 run を見つけ、
// %/h と ETA を算出する。永続化と bridge は log.ts (Imperative Shell) が担う。

export type BatteryEvent = { level: number; ts: number }
export type DrainRate = { pctPerHour: number; etaMs: number | null }

const DEFAULT_MAX = 64
const MAX_GAP_MS = 2 * 60 * 60 * 1000 // 2h 以上空いたら別 run (スリープ/長時間放置を跨がない)
const MIN_SPAN_MS = 60 * 1000 // 最低スパン (これ未満はノイズとして無視)

// level 変化時のみ追記する。直近と同 level は無視 (重複イベント抑制)。上限超過は古い方から drop。
export function appendBatteryEvent(
  ring: BatteryEvent[],
  ev: BatteryEvent,
  max = DEFAULT_MAX,
): BatteryEvent[] {
  const last = ring[ring.length - 1]
  if (last && last.level === ev.level) return ring
  const next = [...ring, ev]
  return next.length > max ? next.slice(next.length - max) : next
}

// 直近の単調減少 run からレートを算出する。ring は時刻昇順。
// 末尾から後方へ走査し、より古い event が現在以上の level (=放電方向) かつ gap<=2h の間 run を延ばす。
// forward 方向で level が上昇する (充電) か gap 超過で打ち切る。strict decrease かつ span>=60s が無ければ null。
//   pctPerHour = (runOldLevel - runNewLevel) / (runNewTs - runOldTs) * 3_600_000
//   etaMs = currentLevel / pctPerHour 時間 (rate<=0 や不明は null)
export function computeDrainRate(ring: BatteryEvent[], currentLevel: number): DrainRate | null {
  if (ring.length < 2) return null
  const newest = ring.length - 1
  let oldest = newest
  for (let i = newest - 1; i >= 0; i--) {
    const newer = ring[i + 1]
    const older = ring[i]
    if (newer.ts - older.ts > MAX_GAP_MS) break // 長い gap で run 終了
    if (older.level < newer.level) break // forward 方向で上昇 (=充電) → run 終了
    oldest = i
  }
  const a = ring[oldest]
  const b = ring[newest]
  const drop = a.level - b.level
  const span = b.ts - a.ts
  if (drop <= 0 || span < MIN_SPAN_MS) return null
  const pctPerHour = (drop / span) * 3_600_000
  const etaMs = pctPerHour > 0 ? (currentLevel / pctPerHour) * 3_600_000 : null
  return { pctPerHour, etaMs }
}

// ミリ秒を "45m" / "6h" / "1h20m" 形式へ。
function humanizeMs(ms: number): string {
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m ? `${h}h${m}m` : `${h}h`
}

// drain segment の表示文字列。null や rate<=0 は '' (segment を出さない)。例 "↓12%/h"。
export function formatRate(rate: DrainRate | null): string {
  if (!rate || rate.pctPerHour <= 0) return ''
  return `↓${Math.round(rate.pctPerHour)}%/h`
}

// est segment の表示文字列 (残り時間)。etaMs 無しは '' (segment を出さない)。例 "6h" / "1h20m"。
export function formatEta(rate: DrainRate | null): string {
  if (!rate || rate.etaMs == null) return ''
  return humanizeMs(rate.etaMs)
}
