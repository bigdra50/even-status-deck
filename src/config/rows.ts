// view 内の「行集合」を列挙する visitor (Issue #17)。行集合 = glassLayout (legacy) /
// 各 page.layout / 各 page.grid (cells 横断で 1 集合)。source 削除・id remap・統合・clock 統合
// などの segKey 一括変換が、線形 layout と grid セルを漏れなく同じ規則で更新するための単一経路。
// 集合単位の read/write 抽象なので、merge 系は集合内で dedup 状態を共有できる。
// 注: normalize 前の壊れた形 (rows が配列でない等) は安全に無視する (consolidateClock は
// backfillPages による pages 正規化より先に走るため)。
import type { GlassPage, ProfileView } from './types'

export type RowSet = {
  read(): string[][]
  write(rows: string[][]): void
}

function layoutRowSet(lay: { rows: string[][] }): RowSet {
  return {
    read: () => lay.rows,
    write: (rows) => {
      lay.rows = rows
    },
  }
}

// grid は cells の rows を連結して 1 集合に見せる (write は各セルの行数で切り戻す)。
// 変換は行単位 (行数を変えない) である前提。
function gridRowSet(page: GlassPage): RowSet | null {
  const cells = (page.grid?.cells ?? []).filter((c) => Array.isArray(c?.rows))
  if (!cells.length) return null
  return {
    read: () => cells.flatMap((c) => c.rows),
    write: (rows) => {
      let i = 0
      for (const c of cells) {
        c.rows = rows.slice(i, i + c.rows.length)
        i += c.rows.length
      }
    },
  }
}

// legacy: false で glassLayout (legacy) を除外する (pruneOrphans は従来 pages のみ掃除する。回帰最小)。
export function viewRowSets(view: ProfileView, opts: { legacy?: boolean } = {}): RowSet[] {
  const out: RowSet[] = []
  if (opts.legacy !== false && Array.isArray(view.glassLayout?.rows)) {
    out.push(layoutRowSet(view.glassLayout))
  }
  for (const page of view.pages ?? []) {
    if (Array.isArray(page?.layout?.rows)) out.push(layoutRowSet(page.layout))
    const g = page ? gridRowSet(page) : null
    if (g) out.push(g)
  }
  return out
}

// 全行へ行単位の変換を適用する (集合間で状態を共有しない場合の便宜ヘルパ)。
export function mapViewRows(
  view: ProfileView,
  fn: (row: string[]) => string[],
  opts?: { legacy?: boolean },
): void {
  for (const rs of viewRowSets(view, opts)) rs.write(rs.read().map(fn))
}
