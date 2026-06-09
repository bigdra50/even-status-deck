import { GRID_COLS, GRID_ROWS, MAX_ROWS } from '../glass-types'
import { segKey } from '../visibility/keys'
import { BUILTIN_SOURCE_ID, LABEL_SEG } from './constants'
import { isRightDivider } from './ids'
import { activeView, cloneGlassLayout } from './profiles'
import { viewRowSets } from './rows'
import type {
  Config,
  GlassGrid,
  GlassLayout,
  GlassPage,
  GridCellSpec,
  ProfileView,
  SegMeta,
} from './types'

function emptyRows(): string[][] {
  return Array.from({ length: MAX_ROWS }, () => [])
}

// 行内の key 列を検証する (string のみ採用 / 廃止済 @label 配置 chip を除去)。
function sanitizeRowKeys(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && !s.endsWith(`|${LABEL_SEG}`))
    : []
}

// 行内の @right は 1 個のみ有効 (最初を残し残りを除去)。前=左 / 後=右クラスタの区切り。
function onceDivider(row: string[]): string[] {
  let seen = false
  return row.filter((k) => {
    if (!isRightDivider(k)) return true
    if (seen) return false
    seen = true
    return true
  })
}

// 永続化された customLabels を検証する (id -> {text})。text 文字列のみ採用。
function sanitizeCustomLabels(x: unknown): Record<string, { text: string }> {
  const out: Record<string, { text: string }> = {}
  if (x && typeof x === 'object') {
    for (const [id, v] of Object.entries(x as Record<string, unknown>)) {
      const t = (v as { text?: unknown })?.text
      if (typeof t === 'string') out[id] = { text: t }
    }
  }
  return out
}

// 永続化された glassLayout を新形式 (固定 MAX_ROWS 行) に正規化する。
// 旧 anchor 形式 ({rows:[{anchor,items}]}) は絶対行へ移行 (top は上から / bottom は下から)。
// 壊れていれば undefined (= 自動描画にフォールバック)。
export function normalizeGlassLayout(x: unknown): GlassLayout | undefined {
  if (!x || typeof x !== 'object') return undefined
  const rowsRaw = (x as { rows?: unknown }).rows
  if (!Array.isArray(rowsRaw)) return undefined
  const customLabels = sanitizeCustomLabels((x as { customLabels?: unknown }).customLabels)
  // 新形式: rows が string[][]
  if (rowsRaw.every((r) => Array.isArray(r))) {
    const rows = emptyRows()
    for (let i = 0; i < MAX_ROWS; i++) rows[i] = onceDivider(sanitizeRowKeys(rowsRaw[i]))
    return { rows, customLabels }
  }
  // 旧 anchor 形式 → 絶対行 (top は上から / bottom は下から詰める)
  const top: string[][] = []
  const bottom: string[][] = []
  for (const r of rowsRaw) {
    if (!r || typeof r !== 'object') continue
    const rr = r as { anchor?: unknown; items?: unknown }
    const items = sanitizeRowKeys(rr.items)
    if (!items.length) continue
    ;(rr.anchor === 'bottom' ? bottom : top).push(items)
  }
  const rows = emptyRows()
  let i = 0
  for (const r of top) if (i < MAX_ROWS) rows[i++] = r
  let j = MAX_ROWS - 1
  for (let k = bottom.length - 1; k >= 0 && j >= i; k--) rows[j--] = bottom[k]
  return { rows, customLabels }
}

// ── grid 定義の正規化 (Issue #17) ──

// 2 つのセル矩形が重なるか (半開区間の交差判定)。
function cellsIntersect(a: GridCellSpec, b: GridCellSpec): boolean {
  return (
    a.col < b.col + b.colSpan &&
    b.col < a.col + a.colSpan &&
    a.row < b.row + b.rowSpan &&
    b.row < a.row + a.rowSpan
  )
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

function clampIntOrNull(v: unknown, lo: number, hi: number): number | null {
  const n = intOrNull(v)
  return n == null ? null : Math.max(lo, Math.min(hi, n))
}

// セル矩形の検証。整数で 12×10 に完全に収まり span>=1 でなければ null。
function sanitizeCellGeometry(
  r: Record<string, unknown>,
): Pick<GridCellSpec, 'col' | 'row' | 'colSpan' | 'rowSpan'> | null {
  const col = intOrNull(r.col)
  const row = intOrNull(r.row)
  const colSpan = intOrNull(r.colSpan)
  const rowSpan = intOrNull(r.rowSpan)
  if (col == null || row == null || colSpan == null || rowSpan == null) return null
  if (col < 0 || row < 0 || colSpan < 1 || rowSpan < 1) return null
  if (col + colSpan > GRID_COLS || row + rowSpan > GRID_ROWS) return null
  return { col, row, colSpan, rowSpan }
}

// 様式 (border/radius/padding) を clamp して反映する。
// 枠線は rowSpan>=2 のみ (1 行セル ≒28px は枠線が line-height 27px を圧迫して文字が欠ける)。
function applyCellStyle(cell: GridCellSpec, r: Record<string, unknown>): void {
  const border = clampIntOrNull(r.border, 0, 5)
  if (border && cell.rowSpan >= 2) cell.border = border
  const radius = clampIntOrNull(r.radius, 0, 10)
  if (radius) cell.radius = radius
  const padding = clampIntOrNull(r.padding, 0, 16)
  if (padding) cell.padding = padding
}

// 1 セル定義を検証する。invalid は null (clamp しない: 座標を丸めると他セルと重なりやすい。
// drop されたセルの chip は companion の Unplaced 棚に現れるので silent loss にはならない)。
function sanitizeGridCell(raw: unknown, ids: Set<string>): GridCellSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  // 'evt' は compiler が注入する event 層の予約 id (同名コンテナが 2 つできると upgrade 先が壊れる)。
  if (id.length < 1 || id.length > 16 || id === 'evt' || ids.has(id)) return null
  const geom = sanitizeCellGeometry(r)
  if (!geom) return null
  const rows = (Array.isArray(r.rows) ? r.rows : [])
    .slice(0, MAX_ROWS)
    .map((v) => onceDivider(sanitizeRowKeys(v)))
  const cell: GridCellSpec = { id, ...geom, rows }
  applyCellStyle(cell, r)
  return cell
}

// 永続化された grid 定義 (GlassPage.grid) を正規化する。セル数は text 上限 7 まで、
// overlap は定義順で先勝ち。空 cells は有効 (編集途中の状態)。形が壊れていれば undefined。
export function normalizeGlassGrid(x: unknown): GlassGrid | undefined {
  if (!x || typeof x !== 'object') return undefined
  const cellsRaw = (x as { cells?: unknown }).cells
  if (!Array.isArray(cellsRaw)) return undefined
  const cells: GridCellSpec[] = []
  const ids = new Set<string>()
  for (const raw of cellsRaw) {
    if (cells.length >= 7) break
    const c = sanitizeGridCell(raw, ids)
    if (!c) continue
    if (cells.some((p) => cellsIntersect(p, c))) continue
    ids.add(c.id)
    cells.push(c)
  }
  return { cells }
}

// 行集合の旧 clock|time/date を datetime へ畳む (集合内で 1 箇所のみ・重複排除)。
function consolidateClockIn(rows: string[][]): string[][] {
  const oldKeys = new Set([`${BUILTIN_SOURCE_ID}|clock|time`, `${BUILTIN_SOURCE_ID}|clock|date`])
  const dtKey = `${BUILTIN_SOURCE_ID}|clock|datetime`
  let seen = false // datetime は 1 箇所のみ (旧 time/date が別行にあっても先頭へ集約)
  return rows.map((row) =>
    row.flatMap((k) => {
      if (oldKeys.has(k) || k === dtKey) {
        if (seen) return []
        seen = true
        return [dtKey]
      }
      return [k]
    }),
  )
}

// clock を単一 datetime segment に統合する (旧 time/date を廃止)。同バージョン additive 移行:
// 素材 SegMeta から time/date を除去し datetime を確保、active view の segment 可視性と
// glassLayout の旧キーを datetime へ remap する (重複は 1 つに)。
export function consolidateClock(c: Config): void {
  const clock = c.groups[BUILTIN_SOURCE_ID]?.clock
  if (clock) {
    const timeSeg = clock.segments.find((s) => s.id === 'time')
    const dateSeg = clock.segments.find((s) => s.id === 'date')
    const dt = clock.segments.find((s) => s.id === 'datetime')
    if (!dt) {
      // 旧 time/date を 1 つの datetime に統合: format を合成 (区切り 2 スペース)。
      const fmt = [timeSeg?.format ?? '', dateSeg?.format ?? ''].filter(Boolean).join('  ')
      const sm: SegMeta = { id: 'datetime' }
      if (fmt) sm.format = fmt
      clock.segments.push(sm)
    }
    // 既存 datetime は format をそのまま保持 (上書きしない)
    clock.segments = clock.segments.filter((s) => s.id !== 'time' && s.id !== 'date')
  }
  // 全 profile の view(segment 可視性 + glassLayout + pages)を datetime へ畳む。
  // active 限定だと非 active profile に旧 time/date key が残り、切替時に時計 chip が消える。
  for (const p of c.profiles) {
    const vg = p.view.groups[BUILTIN_SOURCE_ID]?.clock
    if (vg) {
      const tEn = vg.segments.time
      const dEn = vg.segments.date
      vg.segments.datetime ??= tEn != null || dEn != null ? !!(tEn || dEn) : true
      delete vg.segments.time
      delete vg.segments.date
    }
    // 行集合 (glassLayout / 各 page.layout / 各 page.grid) ごとに畳む。backfill 前なので壊れた
    // pages (layout=null 等) を含みうるが、viewRowSets が安全に無視する。
    for (const rs of viewRowSets(p.view)) rs.write(consolidateClockIn(rs.read()))
  }
}

// glassLayout を pages[0] へ additive 投影する。pages 既存なら id/name 補完・空 layout 除去・各 layout 正規化のみ。
// 重要: 全 glassLayout remap (location merge / clock 統合 / mac→system 等) の「後」に呼ぶこと。
// pages[0].layout は glassLayout の clone (参照共有しない = editor が両方を書き換える二重真実を防ぐ)。
// glassLayout (legacy) は読込互換で残す。pages があれば以後 render は pages を見る (resolvePages)。
// 1 ページ定義の正規化。layout が壊れていれば null (= 除去)。ただし grid ページは layout
// (凍結スナップショット) が壊れていても空 layout で生かす。mode は grid 実体があるときだけ
// 有効 (表示系 reader の単一分岐軸。実体なしの 'grid' は落とす)。
function normalizePageEntry(p: GlassPage | undefined, i: number): GlassPage | null {
  const grid = normalizeGlassGrid((p as { grid?: unknown } | undefined)?.grid)
  const layout =
    normalizeGlassLayout(p?.layout) ?? (grid ? { rows: emptyRows(), customLabels: {} } : null)
  if (!layout) return null
  const id = typeof p?.id === 'string' && p.id ? p.id : `page-${i + 1}`
  const name = typeof p?.name === 'string' && p.name ? p.name : `Page ${i + 1}`
  const page: GlassPage = { id, name, layout }
  if (grid) {
    page.grid = grid
    if ((p as { mode?: unknown } | undefined)?.mode === 'grid') page.mode = 'grid'
  }
  return page
}

export function backfillPages(view: ProfileView): void {
  if (view.pages?.length) {
    const out = view.pages
      .map((p, i) => normalizePageEntry(p, i))
      .filter((p): p is GlassPage => p !== null)
    view.pages = out.length ? out : undefined
    return
  }
  if (view.glassLayout) {
    view.pages = [{ id: 'page-1', name: 'Page 1', layout: cloneGlassLayout(view.glassLayout) }]
  }
}

// glass layout を active profile の groupOrder + enabled segment から生成する (Customize 時の初期値)。
// 1 group = 1 行を上から詰める。MAX_ROWS を超えた分は配置せず Unplaced 棚 (導出) に出る。
export function generateGlassLayout(cfg: Config): GlassLayout {
  const view = activeView(cfg)
  const rows = emptyRows()
  let i = 0
  for (const ref of view.groupOrder) {
    const vg = view.groups[ref.sourceId]?.[ref.groupId]
    const meta = cfg.groups[ref.sourceId]?.[ref.groupId]
    if (!vg?.enabled || !meta) continue
    const items = meta.segments
      .filter((s) => vg.segments[s.id] ?? true)
      .map((s) => segKey(ref.sourceId, ref.groupId, s.id))
    if (items.length && i < MAX_ROWS) rows[i++] = items
  }
  return { rows, customLabels: {} }
}
