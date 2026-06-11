// store の健全性 (online/stale/offline) 状態遷移と notify 抑制ロジックを純粋関数として切り出す。
// store.ts の cognitive-complexity 警告緩和 + 単体テストでの被覆率向上が目的 (#88 Phase 4)。
// 挙動は変更しない (store.ts から定数/分岐をそのまま移送)。
import type { StatusDoc } from './status-types'

// 失敗時の短期 retry backoff。瞬断は retry で吸収し、全滅 (~70s) で offline 確定。
export const RETRY_BACKOFF_MS = [10_000, 20_000, 40_000]
export const RETRY_MAX = RETRY_BACKOFF_MS.length

export type SourceHealth = 'online' | 'stale' | 'offline'

// 連続失敗回数 (failCount) と直近成功値の有無から鮮度を判定する。
// online=直近成功 / stale=失敗中だが retry 継続 (瞬断吸収) / offline=retry 尽きた (切断確定)。
export function healthFromFailCount(failCount: number, hasStatus: boolean): SourceHealth {
  if (failCount > RETRY_MAX) return 'offline'
  if (failCount > 0) return 'stale'
  return hasStatus ? 'online' : 'offline'
}

// 失敗回数 n (1-indexed、今回の失敗を含む) に対応する retry 遅延。
// stale 窓 (1..RETRY_MAX) の外では retry を仕込まない (undefined)。
export function retryDelayMs(failCount: number): number | undefined {
  if (failCount < 1 || failCount > RETRY_MAX) return undefined
  return RETRY_BACKOFF_MS[failCount - 1]
}

// 失敗時に notify すべきか。health 遷移時のみ true: online->stale (n=1) / stale->offline (n=RETRY_MAX+1)。
// 中間 retry 失敗 (n=2..RETRY_MAX) は health 不変なので false (churn 抑制)。
export function shouldNotifyOnFailure(failCount: number): boolean {
  return failCount === 1 || failCount === RETRY_MAX + 1
}

// 成功時に notify すべきか。値変化 (sigChanged) または offline/stale からの復帰 (wasUnhealthy) で true。
// それ以外の同値 poll は churn 抑制で false。
export function shouldNotifyOnSuccess(sigChanged: boolean, wasUnhealthy: boolean): boolean {
  return sigChanged || wasUnhealthy
}

// status の内容シグネチャ (ts 除く)。同一なら notify せず無駄な集約/再描画を起こさない。
// state も含める: 値据え置きで state だけ変化 (例 ok→stale) しても再描画が要る (PROTOCOL §3)。
export function statusSig(d: StatusDoc): string {
  return d.groups
    .map(
      (g) =>
        `${g.id}${g.state ?? ''}:${g.segments.map((s) => `${s.id}=${s.value}|${s.percent ?? ''}|${s.reset ?? ''}|${s.state ?? ''}`).join(',')}`,
    )
    .join(';')
}
