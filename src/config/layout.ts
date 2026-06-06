import { MAX_ROWS } from '../glass-types'
import { segKey } from '../visibility/keys'
import { BUILTIN_SOURCE_ID, LABEL_SEG } from './constants'
import { isRightDivider } from './ids'
import { activeView, cloneGlassLayout } from './profiles'
import type { Config, GlassLayout, GlassPage, ProfileView, SegMeta } from './types'

function emptyRows(): string[][] {
  return Array.from({ length: MAX_ROWS }, () => [])
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
  // 旧 @label 配置 chip は廃止 (default-label が自動で group 名を出す) → rows から除去。
  const strList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === 'string' && !s.endsWith(`|${LABEL_SEG}`))
      : []
  const customLabels = sanitizeCustomLabels((x as { customLabels?: unknown }).customLabels)
  // 行内の @right は 1 個のみ有効 (最初を残し残りを除去)。前=左 / 後=右クラスタの区切り。
  const onceDivider = (row: string[]): string[] => {
    let seen = false
    return row.filter((k) => {
      if (!isRightDivider(k)) return true
      if (seen) return false
      seen = true
      return true
    })
  }
  // 新形式: rows が string[][]
  if (rowsRaw.every((r) => Array.isArray(r))) {
    const rows = emptyRows()
    for (let i = 0; i < MAX_ROWS; i++) rows[i] = onceDivider(strList(rowsRaw[i]))
    return { rows, customLabels }
  }
  // 旧 anchor 形式 → 絶対行 (top は上から / bottom は下から詰める)
  const top: string[][] = []
  const bottom: string[][] = []
  for (const r of rowsRaw) {
    if (!r || typeof r !== 'object') continue
    const rr = r as { anchor?: unknown; items?: unknown }
    const items = strList(rr.items)
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

// glassLayout の rows から旧 clock|time/date を datetime へ畳む (各 layout で 1 箇所のみ・重複排除)。
function consolidateClockRows(lay: GlassLayout): void {
  const oldKeys = new Set([`${BUILTIN_SOURCE_ID}|clock|time`, `${BUILTIN_SOURCE_ID}|clock|date`])
  const dtKey = `${BUILTIN_SOURCE_ID}|clock|datetime`
  let seen = false // datetime は 1 箇所のみ (旧 time/date が別行にあっても先頭へ集約)
  lay.rows = lay.rows.map((row) =>
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
    if (p.view.glassLayout) consolidateClockRows(p.view.glassLayout)
    // backfill 前なので壊れた pages (layout=null 等) を含みうる。null は backfillPages が後段で除去する。
    for (const page of p.view.pages ?? []) if (page?.layout) consolidateClockRows(page.layout)
  }
}

// glassLayout を pages[0] へ additive 投影する。pages 既存なら id/name 補完・空 layout 除去・各 layout 正規化のみ。
// 重要: 全 glassLayout remap (location merge / clock 統合 / mac→system 等) の「後」に呼ぶこと。
// pages[0].layout は glassLayout の clone (参照共有しない = editor が両方を書き換える二重真実を防ぐ)。
// glassLayout (legacy) は読込互換で残す。pages があれば以後 render は pages を見る (resolvePages)。
export function backfillPages(view: ProfileView): void {
  if (view.pages?.length) {
    const out: GlassPage[] = []
    view.pages.forEach((p, i) => {
      const layout = normalizeGlassLayout(p?.layout)
      if (!layout) return
      const id = typeof p?.id === 'string' && p.id ? p.id : `page-${i + 1}`
      const name = typeof p?.name === 'string' && p.name ? p.name : `Page ${i + 1}`
      out.push({ id, name, layout })
    })
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
