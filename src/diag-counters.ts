// 定常状態 churn 計測用の軽量カウンタ (#4)。永続化・タイマーなし、module-level の累積値のみ。
// companion debug console (diag 行) で save/notify/render の発火回数を可視化し、
// 「定常状態 (poll が安定した後) で save が増えない」ことを実機で確認するために使う。
export type DiagCounterName = 'save' | 'notify' | 'render'

const counts: Record<DiagCounterName, number> = { save: 0, notify: 0, render: 0 }

export function bumpDiag(name: DiagCounterName): void {
  counts[name] += 1
}

export function diagCounts(): Record<DiagCounterName, number> {
  return { ...counts }
}
