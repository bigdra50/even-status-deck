// フルスクリーン WYSIWYG レイアウトエディタ (実験的)。自前 DOM ルート (fsRoot) と pointer ドラッグで配置を編集する独立系。
// 外部からは openFsEditor() のみ呼ばれる。依存方向: fs-editor → {state, render-port, sync, rows, glass-edit, config, glass-render, escape, icons}。
import {
  activeView,
  customLabelId,
  isCustomLabelKey,
  isRightDivider,
  RIGHT_DIVIDER,
  saveConfig,
  sourceById,
} from '../config'
import { esc } from '../escape'
import { MAX_ROWS, splitRowClusters } from '../glass-render'
import { icon } from '../icons'
import { rowOverflow } from './glass-edit'
import { requestRender } from './render-port'
import { allPlaceableKeys, segLabelParts } from './rows'
import { ctx } from './state'
import { editingLayout, statusGroup } from './sync'

// ── Fullscreen WYSIWYG レイアウトエディタ (実験的) ──
// iOS WKWebView は orientation lock / requestFullscreen が不安定なため、CSS で強制横
// (@media portrait で 90° 回転) する。回転コンテナ内では SortableJS の ghost 座標が壊れる
// ため、D&D は Pointer Events で自前実装する (elementFromPoint で行/ゾーンを判定)。
// 永続データは通常エディタと同じ glassLayout.rows + @right を共有する (新フォーマット無し)。
let fsRoot: HTMLElement | null = null
let fsDrag: { key: string; ghost: HTMLElement } | null = null
// 長押し arm 用の保留状態(arm 前)。codex 助言: arm 前はネイティブスクロール優先(tray を探せる)、
// しきい値超え移動で arm キャンセル、静止して timer 発火で初めて drag(ghost 生成 + preventDefault)へ。
let fsPending: {
  key: string
  chip: HTMLElement
  x: number
  y: number
  timer: ReturnType<typeof setTimeout>
} | null = null
const FS_LONGPRESS_MS = 220
const FS_MOVE_CANCEL_PX = 10
const FS_CUSTOM_SECTION = '__labels__' // 未配置 list で custom ラベルをまとめる擬似 source
const fsCollapsedSources = new Set<string>() // 折りたたみ中の source(editor open ごとに clear)

// チップの表示文字列 (実機の値。custom ラベルは本文)。
function fsChipText(key: string): string {
  if (isCustomLabelKey(key)) return editingLayout()?.customLabels[customLabelId(key)]?.text ?? ''
  const [sourceId, groupId, segId] = key.split('|')
  const sg = statusGroup(sourceId, groupId)?.segments.find((s) => s.id === segId)
  const { seg } = segLabelParts(key)
  return sg ? (sg.label ? `${sg.label} ${sg.value}` : sg.value) : seg
}

// glass 風チップ (緑/黒)。showGroup=true のときだけ group 名を薄く前置 (run dedup は呼び出し側)。
// rightSide=true は右クラスタ用に色を変える (左=緑 / 右=ティール) ことで配置側を識別可能にする。
function fsChip(key: string, showGroup: boolean, rightSide: boolean): string {
  const label = isCustomLabelKey(key)
  const { group } = segLabelParts(key)
  const grp = !label && showGroup && group ? `<span class="fs-grp">${esc(group)}</span>` : ''
  const cls = `fs-chip${label ? ' fs-chip-label' : rightSide ? ' fs-chip-r' : ''}`
  const x = `<button class="fs-x" data-action="fs-unplace" data-segkey="${esc(key)}" aria-label="Unplace">${icon('x', { size: 12 })}</button>`
  return `<span class="${cls}" data-segkey="${esc(key)}">${grp}<span class="fs-txt">${esc(fsChipText(key))}</span>${x}</span>`
}

// グループ前置の判定 (showDefaultLabel。未設定は clock=false / 他=true)。
function showsGroupLabel(key: string): boolean {
  const [sourceId, groupId] = key.split('|')
  return activeView(ctx.config).groups[sourceId]?.[groupId]?.showDefaultLabel ?? groupId !== 'clock'
}

// 1 クラスタ (左 or 右) を描画。実機グラスと同じ run dedup: 直前と同じ group の連続では
// group 名を 1 回だけ前置 (例「Mac CPU 46% / Mem 80%」)。custom ラベルは run を切る。
function renderFsCluster(keys: string[], rightSide: boolean): string {
  let prevGroup: string | null = null
  return keys
    .map((key) => {
      if (isCustomLabelKey(key)) {
        prevGroup = null
        return fsChip(key, false, rightSide)
      }
      const groupId = key.split('|')[1] ?? ''
      const showGroup = showsGroupLabel(key) && groupId !== prevGroup
      prevGroup = groupId
      return fsChip(key, showGroup, rightSide)
    })
    .join('')
}

// 未配置 list の 1 行(全幅)。左の grip(touch-action:none)からドラッグ、行本体はスクロール。
// × は不要(未配置)。grip 分離で iOS の「pan が drag を奪う(pointercancel)」を避ける。
function fsListItem(key: string): string {
  const { group } = segLabelParts(key)
  const grp = !isCustomLabelKey(key) && group ? `<span class="fs-grp">${esc(group)}</span>` : ''
  return `<span class="fs-chip fs-li" data-segkey="${esc(key)}"><span class="fs-li-grip">${icon('grip', { size: 14 })}</span>${grp}<span class="fs-txt">${esc(fsChipText(key))}</span></span>`
}

// プレビュー本体 (10 行 × 左/右ゾーン) + 右ペインの未配置 list(source 別折りたたみ) の HTML。
function renderFsBodyHtml(): string {
  const lay = editingLayout()
  if (!lay) return ''
  const rows: string[] = []
  for (let i = 0; i < MAX_ROWS; i++) {
    const { left, right } = splitRowClusters(lay.rows[i] ?? [])
    const over = rowOverflow(lay.rows[i] ?? [])
      ? `<span class="fs-over" title="May be too long for one line">${icon('alert', { size: 12 })}</span>`
      : ''
    rows.push(
      `<div class="fs-row"><div class="fs-zone" data-row="${i}" data-zone="left">${renderFsCluster(left, false)}</div>` +
        `<div class="fs-zone fs-zone-r" data-row="${i}" data-zone="right">${renderFsCluster(right, true)}${over}</div></div>`,
    )
  }
  const placed = new Set(lay.rows.flat().filter((k) => !isRightDivider(k)))
  const tray = allPlaceableKeys().filter((k) => !placed.has(k))
  // 未配置を source 別にグルーピング(出現順保持)。custom ラベルは末尾の擬似 source。
  const bySource = new Map<string, string[]>()
  for (const k of tray) {
    const sid = isCustomLabelKey(k) ? FS_CUSTOM_SECTION : (k.split('|')[0] ?? '?')
    const arr = bySource.get(sid)
    if (arr) arr.push(k)
    else bySource.set(sid, [k])
  }
  const sections = [...bySource.entries()]
    .map(([sid, keys]) => {
      const collapsed = fsCollapsedSources.has(sid)
      const label =
        sid === FS_CUSTOM_SECTION ? 'Labels' : (sourceById(ctx.config, sid)?.label ?? sid)
      const head =
        `<button class="fs-li-head" data-action="fs-toggle-source" data-src="${esc(sid)}">` +
        `${icon(collapsed ? 'chevron-right' : 'chevron-down', { size: 14 })}` +
        `<span class="fs-li-head-label">${esc(label)}</span><span class="fs-li-count">${keys.length}</span></button>`
      return head + (collapsed ? '' : keys.map(fsListItem).join(''))
    })
    .join('')
  const listBody = tray.length ? sections : '<span class="fs-empty">Nothing unplaced</span>'
  const listTitle = tray.length ? `Unplaced (${tray.length})` : 'Unplaced'
  // .fs-canvas が利用可能領域を埋め、.fs-glass がその中で 2:1 にコンテイン (container query)。
  // 右ペイン .fs-tray は未配置の source 別折りたたみ list(縦スクロール)。list へ drop で unplace。
  return `<div class="fs-canvas"><div class="fs-glass">${rows.join('')}</div></div>
    <div class="fs-tray" data-zone="tray"><div class="fs-list-title">${listTitle}</div>${listBody}</div>`
}

function renderFsShell(): string {
  return `<div class="fs-stage">
      <div class="fs-bar"><span class="fs-title">Glass layout — drag items onto the preview</span>
        <button class="fs-done" data-action="fs-done">Done</button></div>
      <div class="fs-body">${renderFsBodyHtml()}</div>
    </div>
    <div class="fs-hint">Rotate your phone to landscape ↻</div>`
}

function refreshFsBody(): void {
  const body = fsRoot?.querySelector('.fs-body')
  if (body) body.innerHTML = renderFsBodyHtml()
}

// 各行を split→join で正規化し、空になった右クラスタの @right を落とす。
function normalizeFsRows(): void {
  const lay = editingLayout()
  if (!lay) return
  lay.rows = lay.rows.map((r) => {
    const { left, right } = splitRowClusters(r)
    return right.length ? [...left, RIGHT_DIVIDER, ...right] : left
  })
}

function removeFsKey(key: string): void {
  const lay = editingLayout()
  if (lay) lay.rows = lay.rows.map((r) => r.filter((k) => k !== key))
}

function moveFsKeyToZone(key: string, rowIdx: number, side: 'left' | 'right'): void {
  const lay = editingLayout()
  if (!lay) return
  removeFsKey(key) // 重複配置を防ぐ (どこから来ても 1 箇所だけ)
  const { left, right } = splitRowClusters(lay.rows[rowIdx] ?? [])
  if (side === 'right') right.push(key)
  else left.push(key)
  lay.rows[rowIdx] = right.length ? [...left, RIGHT_DIVIDER, ...right] : left
  normalizeFsRows()
}

function fsZoneAt(e: PointerEvent): HTMLElement | null {
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  return el?.closest('.fs-zone, .fs-tray') ?? null
}

function fsClearHot(): void {
  for (const z of document.querySelectorAll('.fs-zone.fs-hot, .fs-tray.fs-hot')) {
    z.classList.remove('fs-hot')
  }
}

function fsPositionGhost(e: PointerEvent): void {
  if (!fsDrag) return
  fsDrag.ghost.style.left = `${e.clientX}px`
  fsDrag.ghost.style.top = `${e.clientY}px`
}

function onFsPointerDown(e: PointerEvent): void {
  if (fsDrag || fsPending) return
  const target = e.target as HTMLElement
  if (target.closest('.fs-x') || target.closest('.fs-done')) return // 削除/閉じるは click で処理
  const chip = target.closest('.fs-chip') as HTMLElement | null
  const key = chip?.dataset.segkey
  if (!chip || !key) return
  // 未配置 list の行: grip(touch-action:none)からのみ即ドラッグ。行本体(touch-action:pan)は
  // ネイティブスクロールに委ねる。iOS WKWebView で「pan 許可 + arm 後 preventDefault」が pointercancel
  // になり list→preview のドラッグが成立しない問題への対処(grip を none に分離)。
  if (chip.classList.contains('fs-li')) {
    if (!target.closest('.fs-li-grip')) return
    e.preventDefault()
    startFsDrag(chip, key, e.clientX, e.clientY)
    return
  }
  // preview chip(touch-action:none、スクロール先なし): 移動 or 長押しで arm。
  fsPending = {
    key,
    chip,
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(armFsDrag, FS_LONGPRESS_MS),
  }
  window.addEventListener('pointermove', onFsPendingMove)
  window.addEventListener('pointerup', clearFsPending)
  window.addEventListener('pointercancel', clearFsPending)
}

function clearFsPending(): void {
  if (!fsPending) return
  clearTimeout(fsPending.timer)
  fsPending = null
  window.removeEventListener('pointermove', onFsPendingMove)
  window.removeEventListener('pointerup', clearFsPending)
  window.removeEventListener('pointercancel', clearFsPending)
}

// preview chip のみ pending を使う。移動 = ドラッグ意図 → arm(scroll 先が無いので即)。
function onFsPendingMove(e: PointerEvent): void {
  if (!fsPending) return
  if (Math.hypot(e.clientX - fsPending.x, e.clientY - fsPending.y) > FS_MOVE_CANCEL_PX) armFsDrag()
}

// 長押し成立(preview chip): pending から drag へ。
function armFsDrag(): void {
  if (!fsPending) return
  const { key, chip, x, y } = fsPending
  clearFsPending()
  startFsDrag(chip, key, x, y)
}

// ドラッグ開始: ghost 生成 + drag リスナ登録(grip 即時 / preview arm の共通処理)。
function startFsDrag(chip: HTMLElement, key: string, x: number, y: number): void {
  const ghost = chip.cloneNode(true) as HTMLElement
  ghost.classList.add('fs-ghost')
  if (window.matchMedia('(orientation: portrait)').matches) ghost.classList.add('fs-ghost-rot')
  ghost.style.left = `${x}px`
  ghost.style.top = `${y}px`
  document.body.appendChild(ghost)
  fsDrag = { key, ghost }
  chip.classList.add('fs-chip-armed') // 元 chip を薄く(移動中の出所表示)。refreshFsBody で復帰。
  window.addEventListener('pointermove', onFsPointerMove)
  window.addEventListener('pointerup', onFsPointerUp)
  window.addEventListener('pointercancel', onFsDragAbort)
}

// drag 中の中断(pointercancel)。配置は変えずに後始末する。
function onFsDragAbort(): void {
  window.removeEventListener('pointermove', onFsPointerMove)
  window.removeEventListener('pointerup', onFsPointerUp)
  window.removeEventListener('pointercancel', onFsDragAbort)
  fsDrag?.ghost.remove()
  fsDrag = null
  fsClearHot()
  refreshFsBody()
}

function onFsPointerMove(e: PointerEvent): void {
  if (!fsDrag) return
  e.preventDefault()
  fsPositionGhost(e)
  fsClearHot()
  fsZoneAt(e)?.classList.add('fs-hot')
}

// unplace 後、その key の source セクションを開く(折りたたみ中だと list 上で消えたように見えるため)。
function fsExpandSourceOf(key: string): void {
  fsCollapsedSources.delete(isCustomLabelKey(key) ? FS_CUSTOM_SECTION : (key.split('|')[0] ?? '?'))
}

function onFsPointerUp(e: PointerEvent): void {
  window.removeEventListener('pointermove', onFsPointerMove)
  window.removeEventListener('pointerup', onFsPointerUp)
  window.removeEventListener('pointercancel', onFsDragAbort)
  const drag = fsDrag
  fsDrag = null
  drag?.ghost.remove()
  fsClearHot()
  if (!drag || !editingLayout()) return
  const zone = fsZoneAt(e)
  if (!zone) return
  if (zone.classList.contains('fs-tray')) {
    removeFsKey(drag.key)
    fsExpandSourceOf(drag.key) // 折りたたみ中の source へ戻すと消えて見えるので開く
    normalizeFsRows()
  } else {
    const row = Number(zone.dataset.row)
    if (!Number.isInteger(row)) return
    moveFsKeyToZone(drag.key, row, zone.dataset.zone === 'right' ? 'right' : 'left')
  }
  void saveConfig(ctx.config)
  refreshFsBody()
}

// onFsClick が処理する action 一覧 (下の if 連鎖の鏡。契約テスト actions.test.ts が
// 「放出された data-action ⊆ ハンドラ集合」の分類に使う)。連鎖に増減があればここも揃える。
export const FS_ACTIONS = ['fs-done', 'fs-toggle-source', 'fs-unplace'] as const

function onFsClick(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
  if (!t) return
  if (t.dataset.action === 'fs-done') {
    closeFsEditor()
    return
  }
  if (t.dataset.action === 'fs-toggle-source') {
    const sid = t.dataset.src
    if (sid) {
      if (fsCollapsedSources.has(sid)) fsCollapsedSources.delete(sid)
      else fsCollapsedSources.add(sid)
      refreshFsBody()
    }
    return
  }
  if (t.dataset.action === 'fs-unplace') {
    const key = t.dataset.segkey
    if (key && editingLayout()) {
      removeFsKey(key)
      fsExpandSourceOf(key) // 折りたたみ中の source へ戻すと消えて見えるので開く
      normalizeFsRows()
      void saveConfig(ctx.config)
      refreshFsBody()
    }
  }
}

export function openFsEditor(): void {
  if (fsRoot) return
  fsCollapsedSources.clear() // open ごとに全 source 展開で開始
  fsRoot = document.createElement('div')
  fsRoot.className = 'fs-root'
  fsRoot.innerHTML = renderFsShell()
  document.body.appendChild(fsRoot)
  document.body.style.overflow = 'hidden' // 背面(companion)スクロールをロック(tray pan が body へ漏れない保険)
  fsRoot.addEventListener('pointerdown', onFsPointerDown)
  fsRoot.addEventListener('click', onFsClick)
}

function closeFsEditor(): void {
  if (!fsRoot) return
  clearFsPending()
  fsRoot.removeEventListener('pointerdown', onFsPointerDown)
  fsRoot.removeEventListener('click', onFsClick)
  window.removeEventListener('pointermove', onFsPointerMove)
  window.removeEventListener('pointerup', onFsPointerUp)
  window.removeEventListener('pointercancel', onFsDragAbort)
  fsDrag?.ghost.remove()
  fsDrag = null
  fsRoot.remove()
  fsRoot = null
  document.body.style.overflow = '' // 背面スクロールロックを解除
  requestRender() // 通常画面のプレビューを最新化
}
