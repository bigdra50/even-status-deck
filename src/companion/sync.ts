// companion のデータ同期・プレビュー・プリセット遷移ヘルパ。ctx(./state) と外部モジュールだけに依存し、
// index/debug-console は import しない (no-circular)。rows/glass-edit/views/actions はここを共有する。
import { localStatus } from '../builtins'
import {
  activeView,
  BUILTIN_SOURCE_ID,
  type GlassLayout,
  type GlassPage,
  type GridCellSpec,
  type GroupRef,
  saveConfig,
  syncSourceWithStatus,
} from '../config'
import { resolveDisplayLabels } from '../display-identity'
import { esc } from '../escape'
import { cellRect, LINE_H } from '../glass-layout'
import {
  type GlassData,
  layoutRowClusters,
  MAX_ROWS,
  type RowClusters,
  rowSlotClusters,
  summarySections,
} from '../glass-render'
import { GRID_COLS, GRID_ROWS } from '../glass-types'
import type { Group, SourceState } from '../status-types'
import {
  getAllStatuses,
  getOnlineServerIds,
  getRenderableStatuses,
  getSourceHealth,
  getSourceStatus,
  setSourcesFromConfig,
} from '../store'
import { suggestProfile } from '../suggest'
import { createVisibilityRuntime, segKey, type VisibleMap } from '../visibility'
import { requestRender } from './render-port'
import { ctx } from './state'

// builtin (clock/g2) は config の format/widthChars を反映した live 値で上書きする
// (store の builtin は config 非依存の既定値なので、プレビュー/Items を選択に追従させる)。
function glassData(): GlassData {
  // glass/preview は offline source を除いた renderable を使う (実機同様に古い値=嘘を出さない)。
  return {
    config: ctx.config,
    statuses: { ...getRenderableStatuses(), [BUILTIN_SOURCE_ID]: localStatus(ctx.config) },
  }
}

export function statusGroup(sourceId: string, groupId: string): Group | undefined {
  const doc = sourceId === BUILTIN_SOURCE_ID ? localStatus(ctx.config) : getSourceStatus(sourceId)
  return doc?.groups.find((g) => g.id === groupId)
}

// 全ソースの status を config に取り込み、追加があれば保存する。追加があれば true。
export function syncAll(): boolean {
  let changed = false
  for (const [sid, status] of Object.entries(getAllStatuses())) {
    if (status && syncSourceWithStatus(ctx.config, sid, status)) changed = true
  }
  if (changed) void saveConfig(ctx.config)
  return changed
}

// segment の displayLabel を desired に合わせて更新。変化時 true。
function applySegmentLabel(
  sm: { displayLabel?: string },
  key: string,
  desired: Map<string, string | null>,
): boolean {
  if (!desired.has(key)) return false // offline/未取得は維持
  const want = desired.get(key)
  if (want) {
    if (sm.displayLabel !== want) {
      sm.displayLabel = want
      return true
    }
    return false
  }
  if (sm.displayLabel !== undefined) {
    delete sm.displayLabel
    return true
  }
  return false
}

// group 内の全 segment に displayLabel を適用。いずれか変化時 true。
function applyGroupLabels(
  srcId: string,
  gid: string,
  meta: { segments: { id: string; displayLabel?: string }[] },
  desired: Map<string, string | null>,
): boolean {
  let changed = false
  for (const sm of meta.segments) {
    const key = segKey(srcId, gid, sm.id)
    if (applySegmentLabel(sm, key, desired)) changed = true
  }
  return changed
}

// 表示モデル Phase2: 同系統データ衝突を解決し SegMeta.displayLabel を素材へ確定する(永続)。
// 衝突 category の segment に "owner label" を焼き込み、非衝突はクリアする(resolve は純関数)。
// online/offline で揺れないよう offline source は触らない。getRenderableStatuses は offline を null 化
// するので(getAllStatuses の保持値とは違い)、offline segment は desired に出ず既存値が維持される。
export function applyDisplayLabels(): boolean {
  const statuses = { ...getRenderableStatuses(), [BUILTIN_SOURCE_ID]: localStatus(ctx.config) }
  const desired = resolveDisplayLabels(ctx.config, statuses)
  let changed = false
  for (const src of ctx.config.sources) {
    const groups = ctx.config.groups[src.id]
    if (!groups) continue
    for (const [gid, meta] of Object.entries(groups)) {
      if (applyGroupLabels(src.id, gid, meta, desired)) changed = true
    }
  }
  return changed
}

// ── プレビュー ──
// custom (glassLayout あり): 固定行を絶対位置で描画 (空行も保持。上詰め/下詰めは無い)。
// auto (未カスタマイズ): 従来の group=1行 + top/bottom 詰め。glass には操作ヒントを出さない。
// preview 専用の visibility runtime。glass と state/timer を分離する (edge 取りこぼし防止)。
// wake=false: preview は store 更新で再評価されるので窓終了タイマーは張らない (二重 poke 回避)。
const previewVisibility = createVisibilityRuntime({ wake: false })

// 現在編集中ページ (pageEditingIdx) の layout。auto デッキ (pages 未設定) なら undefined。
export function editingLayout(): GlassLayout | undefined {
  return activeView(ctx.config).pages?.[ctx.pageEditingIdx]?.layout
}

// 空の glass layout (新規ページ用。全行空・customLabels なし)。
export function emptyGlassLayout(): GlassLayout {
  return { rows: Array.from({ length: MAX_ROWS }, () => []), customLabels: {} }
}

// 行 HTML: 右クラスタがあれば flex space-between で右端へ寄せる
// (実機の space 近似と違い、プレビューは px 量子化せず正確に左右配置する)。
const growHtml = (l: string): string => `<span class="grow">${l ? esc(l) : '&nbsp;'}</span>`
const rowHtml = ({ left, right }: RowClusters): string =>
  right
    ? `<div class="grow gjust"><span>${left ? esc(left) : ''}</span><span class="gj-r">${esc(right)}</span></div>`
    : growHtml(left)

// grid ページのプレビュー。セルを 12×10 の % で絶対配置し、セル内行は linear と同じ
// 左右クラスタ表示。行数は実機と同じセル内寸の行容量に clamp する。
function gridPreviewHtml(page: GlassPage, d: GlassData, visible: VisibleMap): string {
  const cellHtml = (c: GridCellSpec): string => {
    const { h } = cellRect(c)
    const inset = 2 * ((c.border ?? 0) + (c.padding ?? 0))
    const budget = Math.max(1, Math.floor((h - inset) / LINE_H))
    const count = Math.min(c.rows.length, budget)
    const lines = rowSlotClusters(c.rows, page.layout.customLabels, d, visible, count)
    const style = [
      `left:${(c.col / GRID_COLS) * 100}%`,
      `top:${(c.row / GRID_ROWS) * 100}%`,
      `width:${(c.colSpan / GRID_COLS) * 100}%`,
      `height:${(c.rowSpan / GRID_ROWS) * 100}%`,
    ].join(';')
    const cls = c.border ? 'gpv-cell gpv-cell-border' : 'gpv-cell'
    return `<div class="${cls}" style="${style}" data-cellid="${esc(c.id)}">${lines.map(rowHtml).join('')}</div>`
  }
  const cells = page.grid?.cells ?? []
  return `<div class="glass-screen gpv-gridscreen">${cells.map(cellHtml).join('')}</div>`
}

export function glassPreviewHtml(): string {
  const visible = previewVisibility.compute(ctx.config, getRenderableStatuses()).map
  const d = glassData()
  const page = activeView(ctx.config).pages?.[ctx.pageEditingIdx]
  if (page?.mode === 'grid' && page.grid) return gridPreviewHtml(page, d, visible)
  const lay = editingLayout()
  if (lay) {
    return `<div class="glass-screen">${layoutRowClusters(lay, d, visible, MAX_ROWS).map(rowHtml).join('')}</div>`
  }
  const { top, bottom } = summarySections(d, visible)
  if (top.length + bottom.length === 0) top.push('(no metric)')
  return `<div class="glass-screen"><div class="gsec gsec-top">${top.map(growHtml).join('')}</div><div class="gsec gsec-bot">${bottom.map(growHtml).join('')}</div></div>`
}

// ── 表示項目 (groupOrder 横断) ──
// 実在する (status にある) group だけを active view の groupOrder 順に並べる。
export function visibleRefs(): GroupRef[] {
  return activeView(ctx.config).groupOrder.filter((r) => statusGroup(r.sourceId, r.groupId))
}

// ソースが報告する最悪状態 (PROTOCOL §3, transport 鮮度とは別軸)。segment.state は group.state を上書き。
export const STATE_RANK: Record<SourceState, number> = { ok: 0, stale: 1, error: 2 }
export function worstReportedState(sourceId: string): { state: SourceState; message?: string } {
  const doc = getSourceStatus(sourceId)
  let worst: SourceState = 'ok'
  let message: string | undefined
  for (const g of doc?.groups ?? []) {
    const gs = g.state ?? 'ok'
    if (STATE_RANK[gs] > STATE_RANK[worst]) {
      worst = gs
      message = g.message
    }
    for (const seg of g.segments) {
      const ss = seg.state ?? g.state ?? 'ok'
      if (STATE_RANK[ss] > STATE_RANK[worst]) {
        worst = ss
        message = seg.message ?? g.message
      }
    }
  }
  return { state: worst, message }
}

// 表示項目リストの構成シグネチャ (順序込み)。変化したら項目リストを再描画する。
export function visibleSig(): string {
  // group 構成に加え source の鮮度も含める。health 遷移 (online/stale/offline) でも
  // conn-dot と glass preview を再描画するため (offline で preview から group が消える)。
  const refs = visibleRefs()
    .map((r) => `${r.sourceId}:${r.groupId}`)
    .join('|')
  const health = ctx.config.sources
    .filter((s) => s.kind === 'server')
    .map((s) => `${s.id}=${getSourceHealth(s.id)}/${worstReportedState(s.id).state}`)
    .join(',')
  return `${refs}#${health}`
}

// オンラインな server source 集合から最適 profile を求める純粋関数 (suggestProfile) を呼び、
// このセッションで却下済み (dismissedSuggestions) の提案は除外する。currentSuggestion を更新し、
// 提示すべき内容が変わったか (profileId の差分) を返す (変化時のみ Home を再描画するため)。
export function recomputeSuggestion(): boolean {
  const next = suggestProfile(ctx.config, getOnlineServerIds())
  const shown = next && !ctx.dismissedSuggestions.has(next.profileId) ? next : null
  const changed = (ctx.currentSuggestion?.profileId ?? null) !== (shown?.profileId ?? null)
  ctx.currentSuggestion = shown
  return changed
}

export function parseKey(key: string): GroupRef {
  const [sourceId, groupId] = key.split('|')
  return { sourceId: sourceId ?? '', groupId: groupId ?? '' }
}

// profile を切替/複製/追加した後の共通処理。enabledSourceIds が変わるので store の fetch 範囲を
// 更新し (setSourcesFromConfig)、glass へは saveConfig の config-changed が view 差し替えを伝える。
// layoutEditing は profile を跨ぐと配置が混乱するため必ず解除する。
// syncAll: 切替先 (新規/複製先) の view が空でも、既に取得済みの status から group/segment 枠を
//   補充する (setSourcesFromConfig は未変更ソースを再 fetch しない = onStoreUpdate が来ないため、
//   ここで明示的に active view へ反映してから描画する)。
export function applyProfileChange(): void {
  ctx.layoutEditing = false
  ctx.pageEditingIdx = 0
  void saveConfig(ctx.config)
  syncAll() // 切替先 view を cached status から補充 (変化あれば内部で保存)
  setSourcesFromConfig(ctx.config)
  requestRender() // requestRender() が Home 描画前に recomputeSuggestion する (active 変更で提案が変わる)
}
