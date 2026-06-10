// segment 値の数値履歴 (メモリ内 ring buffer)。sparkline image cell (Issue #17) のデータ源。
// 永続化しない (セッション内のみ)。store が status を取り込むたびに recordStatusHistory で更新する。
// 値の解釈: percent があれば percent、無ければ value 先頭の数値 (単位付き '42%' '3.2GB' 等も拾う)。
import type { StatusDoc } from './status-types'
import { segKey } from './visibility/keys'

export type HistorySample = { t: number; v: number }

const MAX_SAMPLES = 64
// series (segKey) 数の全体上限。超過時は最終更新が最古の series を捨てる
// (動的 segment id や source 削除でキーが増え続けるのを防ぐ)。
const MAX_SERIES = 256
// 同一 t (同じ poll) の重複記録を避ける最小間隔。
const MIN_INTERVAL_MS = 5_000

const series = new Map<string, HistorySample[]>()

function evictStalest(): void {
  let oldest: string | null = null
  let oldestT = Number.POSITIVE_INFINITY
  for (const [k, s] of series) {
    const t = s[s.length - 1]?.t ?? 0
    if (t < oldestT) {
      oldestT = t
      oldest = k
    }
  }
  if (oldest) series.delete(oldest)
}

// segment 値から数値を取り出す。数値が無ければ null。
export function numericValueOf(seg: { value: string; percent?: number }): number | null {
  if (typeof seg.percent === 'number') return seg.percent
  const m = seg.value.match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}

export function recordHistory(key: string, v: number, t: number): void {
  if (!series.has(key) && series.size >= MAX_SERIES) evictStalest()
  const s = series.get(key) ?? []
  const last = s[s.length - 1]
  if (last && t - last.t < MIN_INTERVAL_MS) {
    last.v = v // 同 poll 内は最新値で上書き (サンプル数を浪費しない)
  } else {
    s.push({ t, v })
    if (s.length > MAX_SAMPLES) s.shift()
  }
  series.set(key, s)
}

// StatusDoc の全 segment を履歴へ取り込む (数値を持つものだけ)。
export function recordStatusHistory(sourceId: string, doc: StatusDoc, t: number): void {
  for (const g of doc.groups) {
    for (const seg of g.segments) {
      const v = numericValueOf(seg)
      if (v != null) recordHistory(segKey(sourceId, g.id, seg.id), v, t)
    }
  }
}

export function historyOf(key: string): HistorySample[] {
  return series.get(key) ?? []
}

export function resetHistory(): void {
  series.clear()
}
