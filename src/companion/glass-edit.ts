// Glass セクションのインライン WYSIWYG 編集・ページ操作・並べ替え (sortable)・swipe-to-delete。
// index.ts から切り出した UI 編集レイヤ。依存は state/render-port/sync/rows と外部のみ (一方向)。

import Sortable from 'sortablejs'
import {
  activeView,
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  customLabelId,
  type GlassLayout,
  type GlassPage,
  type GridCellSpec,
  type GroupRef,
  groupDisplayName,
  isCustomLabelKey,
  isRightDivider,
  RIGHT_DIVIDER,
  saveConfig,
  sourceById,
} from '../config'
import { collisionCategories, effectiveOwner } from '../display-identity'
import { esc } from '../escape'
import { MAX_ROWS, splitRowClusters } from '../glass-render'
import { GRID_COLS, GRID_ROWS } from '../glass-types'
import { icon } from '../icons'
import { canPlace, cellCapacity, findFreeRect, gridPlacedKeys } from './grid-edit'
import { actionButton } from './html'
import { requestPreviewUpdate, requestRender } from './render-port'
import { allPlaceableKeys, groupHeadingCollides, segLabelParts } from './rows'
import { ctx } from './state'
import { editingLayout, glassPreviewHtml, parseKey, statusGroup, visibleRefs } from './sync'

// 行 (key 配列) が glass 1 行 (等幅近似で ~50 桁) に収まらなさそうか。
// segment は widthChars (確保枠) 優先、無ければ value 長。custom ラベルはテキスト長。
// group default-label の前置分も run 先頭で加算 (rowText の dedup と合わせる)。
const ROW_MAX_CHARS = 50

type RowOverflowKeyWidth = { width: number; counts: boolean; nextPrevGroup: string | null }

// custom ラベル key の行幅寄与を返す。スキップ時は null。
function rowOverflowCustomLabelWidth(key: string): RowOverflowKeyWidth | null {
  if (!isCustomLabelKey(key)) return null
  const text = editingLayout()?.customLabels[customLabelId(key)]?.text ?? ''
  if (!text) return null
  return { width: text.length, counts: true, nextPrevGroup: null }
}

// segment key の行幅寄与を返す。スキップ時は null。
function rowOverflowSegmentWidth(
  key: string,
  prevGroup: string | null,
  view: ReturnType<typeof activeView>,
): RowOverflowKeyWidth | null {
  if (isCustomLabelKey(key)) return null
  const [sourceId, groupId, segId] = key.split('|')
  const seg = statusGroup(sourceId, groupId)?.segments.find((s) => s.id === segId)
  if (!seg) return null
  const vg = view.groups[sourceId]?.[groupId]
  const inMeta =
    ctx.config.groups[sourceId]?.[groupId]?.segments.some((s) => s.id === segId) ?? false
  // 無効化された segment は glass(rowText) で描画されないので幅計算からも除外 (過大評価防止)。
  if (!inMeta || !(vg?.segments[segId] ?? true)) return null
  const labelLen = seg.label ? seg.label.length + 1 : 0
  const valLen = seg.widthChars ?? seg.value.length
  let w = labelLen + valLen
  const showsLabel = vg?.showDefaultLabel ?? groupId !== 'clock'
  if (showsLabel && groupId !== prevGroup) {
    const { group } = segLabelParts(key)
    if (group) w += group.length + 1 // run 先頭の group 名前置
  }
  return { width: w, counts: true, nextPrevGroup: groupId }
}

// 1 key 分の行幅寄与を返す。スキップ時は null。
function rowOverflowKeyWidth(
  key: string,
  prevGroup: string | null,
  view: ReturnType<typeof activeView>,
): RowOverflowKeyWidth | null {
  return rowOverflowCustomLabelWidth(key) ?? rowOverflowSegmentWidth(key, prevGroup, view)
}

export function rowOverflow(items: string[], maxChars = ROW_MAX_CHARS): boolean {
  const view = activeView(ctx.config)
  let total = 0
  let n = 0
  let prevGroup: string | null = null
  for (const key of items) {
    const contrib = rowOverflowKeyWidth(key, prevGroup, view)
    if (!contrib) continue
    total += contrib.width
    prevGroup = contrib.nextPrevGroup
    if (contrib.counts) n++
  }
  return total + Math.max(0, n - 1) * 2 > maxChars
}

// WYSIWYG の chip。custom ラベル (自由テキスト) と segment 値 chip の 2 種。
// 値 chip は実機の表示文字列 (label value / value)。group の default-label が ON なら
// group 名を小さく添える (実機で前置されるラベルを editor で可視化。OFF なら出さない)。
// tapAdd: 棚の chip タップで選択中 grid セルへ追加する (grid エディタの棚のみ。drag は grip)。
function wysChip(key: string, opts: { tapAdd?: boolean } = {}): string {
  const grip = `<span class="wys-grip">${icon('grip', { size: 11 })}</span>`
  const tap = opts.tapAdd ? ` data-action="grid-chip-add"` : ''
  // custom ラベル: × は削除 (customLabels から除去)。値 chip の × は unplace。
  if (isCustomLabelKey(key)) {
    const id = customLabelId(key)
    const text = editingLayout()?.customLabels[id]?.text ?? ''
    const del = actionButton('label-delete', icon('x', { size: 10 }), {
      cls: 'wys-x',
      attrs: { 'data-label-id': id },
      title: 'Delete label',
      ariaLabel: 'Delete label',
    })
    return `<span class="wys-chip wys-label-chip wys-custom-chip" data-segkey="${esc(key)}"${tap} title="${esc(text)}">${grip}<span class="wys-txt">${esc(text)}</span>${del}</span>`
  }
  const [sourceId, groupId, segId] = key.split('|')
  const { group, seg } = segLabelParts(key)
  const x = actionButton('layout-item-remove', icon('x', { size: 10 }), {
    cls: 'wys-x',
    attrs: { 'data-segkey': key },
    ariaLabel: 'Unplace',
  })
  const sg = statusGroup(sourceId, groupId)?.segments.find((s) => s.id === segId)
  const text = sg ? (sg.label ? `${sg.label} ${sg.value}` : sg.value) : seg
  // default-label ON の group のみ group 名を薄く前置表示 (実機の前置ラベルに対応)
  const vg = activeView(ctx.config).groups[sourceId]?.[groupId]
  const showsLabel = vg?.showDefaultLabel ?? groupId !== 'clock'
  const grp = group && showsLabel ? `<span class="wys-grp">${esc(group)}</span>` : ''
  // owner バッジ (表示モデル新 IA): 同系統衝突 category の segment だけ、混ぜて並べる picker で出自を区別する。
  const cat = ctx.config.groups[sourceId]?.[groupId]?.segments.find((s) => s.id === segId)?.category
  const src = sourceById(ctx.config, sourceId)
  const ownerBadge =
    cat != null && src && collisionCategories(ctx.config).has(cat)
      ? `<span class="owner-badge owner-fixed" title="Owner">${esc(effectiveOwner(src))}</span>`
      : ''
  return `<span class="wys-chip" data-segkey="${esc(key)}"${tap} title="${esc(group ? `${group} ${seg}` : seg)}">${grip}${grp}${ownerBadge}<span class="wys-txt">${esc(text)}</span>${x}</span>`
}

// 編集モードのキャンバス: 固定 MAX_ROWS 行 (行番号ガター + 左/右ゾーン) + 未配置棚 + Reset。
// 行番号 = glass の上からの絶対位置。glass にヒント行は出さないので予約行も無い (全行配置可)。
// 各行は左ゾーン｜右ゾーンの 2 ドロップ領域。右ゾーンに置いた chip は実機で右寄せされる。
function renderGlassEdit(lay: GlassLayout): string {
  const placed = new Set(lay.rows.flat().filter((k) => !isRightDivider(k)))
  const unplaced = allPlaceableKeys().filter((k) => !placed.has(k))
  const lines: string[] = []
  for (let i = 0; i < MAX_ROWS; i++) {
    const row = lay.rows[i] ?? []
    const { left, right } = splitRowClusters(row)
    const lc = left.map((k) => wysChip(k)).join('')
    const rc = right.map((k) => wysChip(k)).join('')
    const warn = rowOverflow(row)
      ? `<span class="wys-over" title="May be too long for one line">${icon('alert', { size: 12 })}</span>`
      : ''
    lines.push(
      `<div class="wys-line"><span class="wys-ln">${i + 1}</span>` +
        `<div class="wys-cell wys-zone" data-row="${i}" data-zone="left" title="Left">${lc}</div>` +
        `<span class="wys-zone-sep" title="Left ｜ Right"></span>` +
        `<div class="wys-cell wys-zone wys-zone-r" data-row="${i}" data-zone="right" title="Right">${rc}</div>` +
        `${warn}</div>`,
    )
  }
  const shelf = unplaced.length
    ? unplaced.map((k) => wysChip(k)).join('')
    : '<span class="cmp-sub">Nothing unplaced</span>'
  return `<div class="gpv"><div class="gpv-cap">G2 576×288 — editing</div>
      <div class="gpv-screen wys-screen">${lines.join('')}</div></div>
    <div class="cmp-sub">Drag items into the left or right side of a row. Right-side items align to the right edge.</div>
    <div class="cmp-label">Unplaced</div>
    <div class="wys-cell wys-shelf" data-shelf="1">${shelf}</div>
    <div class="field-row wys-add">
      <input class="lay-add-input" type="text" maxlength="64" placeholder="Custom label (heading / divider …)" />
      ${actionButton('label-add', `${icon('plus', { size: 14 })}Add label`, { cls: 'save-btn sm' })}
    </div>
    ${actionButton('layout-reset', 'Reset to auto', { cls: 'danger-btn' })}`
}

// ── grid ページの編集 UI (Issue #17) ──

// 12×10 キャンバス。セルはタップで選択 (steppers で移動/拡縮)。
function renderGridCanvas(page: GlassPage): string {
  const cells = (page.grid?.cells ?? [])
    .map((c) => {
      const sel = c.id === ctx.gridCellSel ? ' grid-cell-sel' : ''
      const style = [
        `left:${(c.col / GRID_COLS) * 100}%`,
        `top:${(c.row / GRID_ROWS) * 100}%`,
        `width:${(c.colSpan / GRID_COLS) * 100}%`,
        `height:${(c.rowSpan / GRID_ROWS) * 100}%`,
      ].join(';')
      const tag = c.kind === 'image' ? ` · ${c.image?.source ?? 'img'}` : ''
      return `<button class="grid-cell${sel}" style="${style}" data-action="grid-cell-select" data-cell-id="${esc(c.id)}" title="${esc(c.id)}">
        <span class="grid-cell-id">${esc(c.id)}</span><span class="grid-cell-size">${c.colSpan}×${c.rowSpan}${tag}</span></button>`
    })
    .join('')
  return `<div class="gpv"><div class="gpv-cap">G2 576×288 — grid 12×10</div>
    <div class="gpv-screen grid-canvas">${cells}</div></div>`
}

// 選択セルの操作列: 移動 (◀▶▲▼) / サイズ (W±/H±) / 枠線 / 削除。実行不能な操作は disabled。
// data-action は静的リテラルで放出する (actions.test.ts のソース走査契約。動的組み立て禁止)。
function renderGridCellControls(page: GlassPage, sel: GridCellSpec): string {
  const grid = page.grid ?? { cells: [] }
  const can = (rect: Partial<GridCellSpec>): boolean => canPlace(grid, { ...sel, ...rect }, sel.id)
  const moveBtn = (
    dx: number,
    dy: number,
    title: string,
    iconName: Parameters<typeof icon>[0],
    ok: boolean,
  ): string =>
    actionButton('grid-cell-move', icon(iconName, { size: 14 }), {
      cls: 'gear-btn',
      attrs: { 'data-dx': dx, 'data-dy': dy },
      title,
      ariaLabel: title,
      disabled: !ok,
    })
  const move = `
    ${moveBtn(-1, 0, 'Move left', 'chevron-left', can({ col: sel.col - 1 }))}
    ${moveBtn(1, 0, 'Move right', 'chevron-right', can({ col: sel.col + 1 }))}
    ${moveBtn(0, -1, 'Move up', 'chevron-up', can({ row: sel.row - 1 }))}
    ${moveBtn(0, 1, 'Move down', 'chevron-down', can({ row: sel.row + 1 }))}`
  const resizeBtn = (
    dim: 'w' | 'h',
    delta: number,
    title: string,
    label: string,
    ok: boolean,
  ): string =>
    actionButton('grid-cell-resize', label, {
      cls: 'gear-btn',
      attrs: { 'data-dim': dim, 'data-delta': delta },
      title,
      ariaLabel: title,
      disabled: !ok,
    })
  const size = `
    ${resizeBtn('w', -1, 'Narrower', 'W−', sel.colSpan > 1)}
    ${resizeBtn('w', 1, 'Wider', 'W+', can({ colSpan: sel.colSpan + 1 }))}
    ${resizeBtn('h', -1, 'Shorter', 'H−', sel.rowSpan > 1)}
    ${resizeBtn('h', 1, 'Taller', 'H+', can({ rowSpan: sel.rowSpan + 1 }))}`
  // 枠線は rowSpan>=2 のみ (1 行セルは line-height を圧迫。config normalize とも一致)。
  const borderOk = sel.rowSpan >= 2
  const borderOn = (sel.border ?? 0) > 0
  const border = actionButton('grid-cell-border', icon('layout', { size: 14 }), {
    cls: `gear-btn${borderOn ? ' seg-on' : ''}`,
    title: 'Toggle border',
    ariaLabel: 'Toggle border',
    disabled: !borderOk,
  })
  return `<div class="grid-ctl">
      <span class="grid-ctl-lbl">${esc(sel.id)} — ${sel.colSpan}×${sel.rowSpan} @ (${sel.col},${sel.row})</span>
      <div class="grid-ctl-row"><span class="cmp-sub">Move</span>${move}<span class="cmp-sub">Size</span>${size}${border}
        ${actionButton('grid-cell-remove', icon('trash', { size: 14 }), { cls: 'gear-btn danger', title: 'Delete cell', ariaLabel: 'Delete cell' })}</div>
    </div>`
}

// 選択セルの行エディタ (容量ぶんの行スロット。左右ゾーン + drag/タップ追加)。
// #grid-rows[data-cell-id] が recompute の書き戻し先マーカー。
function renderGridCellRows(sel: GridCellSpec): string {
  const cap = cellCapacity(sel)
  const maxChars = Math.max(8, Math.round((ROW_MAX_CHARS * sel.colSpan) / GRID_COLS))
  const lines: string[] = []
  for (let i = 0; i < cap; i++) {
    const row = sel.rows[i] ?? []
    const { left, right } = splitRowClusters(row)
    const warn = rowOverflow(row, maxChars)
      ? `<span class="wys-over" title="May be too long for this cell">${icon('alert', { size: 12 })}</span>`
      : ''
    lines.push(
      `<div class="wys-line"><span class="wys-ln">${i + 1}</span>` +
        `<div class="wys-cell wys-zone" data-row="${i}" data-zone="left" title="Left">${left.map((k) => wysChip(k)).join('')}</div>` +
        `<span class="wys-zone-sep" title="Left ｜ Right"></span>` +
        `<div class="wys-cell wys-zone wys-zone-r" data-row="${i}" data-zone="right" title="Right">${right.map((k) => wysChip(k)).join('')}</div>` +
        `${warn}</div>`,
    )
  }
  return `<div class="cmp-label">Cell rows (${cap} line${cap > 1 ? 's' : ''})</div>
    <div id="grid-rows" data-cell-id="${esc(sel.id)}">${lines.join('')}</div>`
}

// grid ページ編集面: キャンバス + 選択セル操作 + セル行エディタ + 未配置棚。
function renderGridEdit(page: GlassPage): string {
  const grid = page.grid ?? { cells: [] }
  const sel = grid.cells.find((c) => c.id === ctx.gridCellSel) ?? null
  const placed = gridPlacedKeys(grid)
  const unplaced = allPlaceableKeys().filter((k) => !placed.has(k))
  const shelf = unplaced.length
    ? unplaced.map((k) => wysChip(k, { tapAdd: !!sel && sel.kind !== 'image' })).join('')
    : '<span class="cmp-sub">Nothing unplaced</span>'
  const addOk = grid.cells.length < 7 && findFreeRect(grid) !== null
  return `${renderGridCanvas(page)}
    <div class="field-row grid-add-row">${actionButton('grid-cell-add', `${icon('plus', { size: 14 })}Add cell`, { cls: 'save-btn sm', disabled: !addOk })}</div>
    ${sel ? renderGridCellControls(page, sel) : '<div class="cmp-sub">Tap a cell on the canvas to move / resize it and fill its rows.</div>'}
    ${sel && sel.kind !== 'image' ? renderGridCellRows(sel) : ''}
    <div class="cmp-label">Unplaced${sel ? ' — tap a chip to add it to the selected cell' : ''}</div>
    <div class="wys-cell wys-shelf" data-shelf="1">${shelf}</div>
    <div class="field-row wys-add">
      <input class="lay-add-input" type="text" maxlength="64" placeholder="Custom label (heading / divider …)" />
      ${actionButton('label-add', `${icon('plus', { size: 14 })}Add label`, { cls: 'save-btn sm' })}
    </div>
    ${actionButton('layout-reset', 'Reset to auto', { cls: 'danger-btn' })}`
}

// auto モード (glassLayout 未設定) の group 並べ替え行。grip + group 名 + owner のみ (設定は出さない)。
// group の横断順序 (groupOrder) は glass の arrange 概念なので Glass セクションに置く (Source Detail ではない)。
function groupOrderRow(ref: GroupRef): string {
  const g = statusGroup(ref.sourceId, ref.groupId)
  if (!g) return ''
  const isBuiltin = ref.sourceId === BUILTIN_SOURCE_ID
  const src = sourceById(ctx.config, ref.sourceId)
  const baseTitle = isBuiltin
    ? (BUILTIN_GROUP_LABELS[ref.groupId] ?? ref.groupId)
    : g.label || src?.label || ref.groupId
  const title = groupDisplayName(ctx.config, ref.sourceId, ref.groupId) ?? baseTitle
  const owner = src ? effectiveOwner(src) : ''
  const key = `${esc(ref.sourceId)}|${esc(ref.groupId)}`
  // 同名で glass マージされる group は行が見分けられないので group id を併記する (衝突時のみ)。
  const gidTag = groupHeadingCollides(ref.sourceId, ref.groupId)
    ? `<span class="src-note">${esc(ref.groupId)}</span>`
    : ''
  return `<div class="src ord-row" data-key="${key}"><div class="src-head">
    <span class="src-grip">${icon('grip', { size: 16 })}</span>
    <span class="src-name">${esc(title)}</span>
    ${gidTag}<span class="src-note">${esc(owner)}</span></div></div>`
}

// auto モードの順序エディタ。#source-list を使い既存 onGroupReorder を再接続する (group sortable)。
// 並べ替え対象が 2 つ未満なら出さない。custom layout 時は renderGlassEdit が配置を持つので出さない。
function renderGlassAutoOrder(): string {
  const refs = visibleRefs()
  if (refs.length < 2) return ''
  return `<div class="cmp-label">Order (auto layout — drag ${icon('grip', { size: 12 })} to reorder)</div>
    <div id="source-list">${refs.map(groupOrderRow).join('')}</div>`
}

// ページ tab 列: [Page1][Page2]…[+]。選択中をハイライト。クリックで選択 / + で追加。
function renderPageTabs(pages: GlassPage[]): string {
  const tabs = pages
    .map((p, i) => {
      const active = i === ctx.pageEditingIdx ? ' page-tab-active' : ''
      return actionButton('page-select', esc(p.name), {
        cls: `page-tab${active}`,
        attrs: { 'data-page-idx': i },
        title: p.name,
      })
    })
    .join('')
  const add = actionButton('page-add', icon('plus', { size: 14 }), {
    cls: 'page-tab page-add',
    title: 'Add page',
    ariaLabel: 'Add page',
  })
  return `<div class="page-tabs">${tabs}${add}</div>`
}

// 編集中ページ (pageEditingIdx) の操作行: 名前 rename / grid 切替 / 左右移動 / 削除。
function renderPageControls(pages: GlassPage[]): string {
  const cur = pages[ctx.pageEditingIdx]
  if (!cur) return ''
  const noUp = ctx.pageEditingIdx === 0
  const noDown = ctx.pageEditingIdx >= pages.length - 1
  const noDel = pages.length <= 1
  const isGrid = cur.mode === 'grid'
  const gridTitle = isGrid ? 'Switch to rows layout' : 'Switch to grid layout'
  return `<div class="page-ctl">
      <input class="page-name-input" type="text" maxlength="24" value="${esc(cur.name)}" data-action="page-rename" data-page-idx="${ctx.pageEditingIdx}" placeholder="Page name" aria-label="Page name" />
      ${actionButton('page-mode-toggle', icon('grid3', { size: 14 }), { cls: `gear-btn${isGrid ? ' seg-on' : ''}`, title: gridTitle, ariaLabel: gridTitle })}
      ${actionButton('page-move-up', icon('chevron-left', { size: 14 }), { cls: 'gear-btn', title: 'Move left', ariaLabel: 'Move left', disabled: noUp })}
      ${actionButton('page-move-down', icon('chevron-right', { size: 14 }), { cls: 'gear-btn', title: 'Move right', ariaLabel: 'Move right', disabled: noDown })}
      ${actionButton('page-remove', icon('trash', { size: 14 }), { cls: 'gear-btn danger', title: 'Delete page', ariaLabel: 'Delete page', disabled: noDel })}
    </div>`
}

// Glass セクション: auto デッキ (pages 未設定) は従来 UI、explicit デッキはページ tab + 選択ページ編集。
export function renderGlassSection(): string {
  const pages = activeView(ctx.config).pages
  if (!pages?.length) {
    return `<div class="cmp-label cmp-label-row">Glass<span class="cmp-actions">
        <button class="gear-btn" data-action="layout-customize" title="Customize layout" aria-label="Customize layout">${icon('layout', { size: 16 })}</button>
        <button class="gear-btn" data-action="fs-open" title="Fullscreen edit (beta)" aria-label="Fullscreen edit">${icon('maximize', { size: 16 })}</button>
      </span></div>
      <div class="gpv"><div class="gpv-cap">G2 576×288</div><div class="gpv-screen">${glassPreviewHtml()}</div></div>
      <div class="cmp-sub">Glass gestures: tap = summary / swipe = switch view / double-tap = exit</div>
      <div class="cmp-sub">One row per group. Customize layout to place items freely on the preview.</div>
      ${renderGlassAutoOrder()}`
  }
  if (ctx.pageEditingIdx >= pages.length) ctx.pageEditingIdx = 0
  const cur = pages[ctx.pageEditingIdx] ?? (pages[0] as GlassPage)
  const isGrid = cur.mode === 'grid' && !!cur.grid
  // 選択セルが現ページに無ければ解除 (ページ/モード切替の取り残し)。
  if (ctx.gridCellSel && !cur.grid?.cells.some((c) => c.id === ctx.gridCellSel)) {
    ctx.gridCellSel = null
  }
  const multi = pages.length > 1
  if (ctx.layoutEditing) {
    const hint = isGrid
      ? `<div class="cmp-sub">Cells place on a 12×10 grid. Tap a cell to select it, then move / resize / fill its rows.</div>`
      : `<div class="cmp-sub">Drag items to rows (1–${MAX_ROWS}) or the Unplaced shelf. Row number = position from top of glass.</div>`
    return `<div class="cmp-label cmp-label-row">Glass pages<button class="gear-btn" data-action="layout-edit-toggle" title="Done" aria-label="Done">${icon('check', { size: 16 })}</button></div>
      ${renderPageTabs(pages)}
      ${renderPageControls(pages)}
      ${hint}
      ${isGrid ? renderGridEdit(cur) : renderGlassEdit(cur.layout)}`
  }
  // fullscreen エディタは行スロット専用 (grid ページでは出さない。凍結 layout を触らせない)。
  const fsBtn = isGrid
    ? ''
    : `<button class="gear-btn" data-action="fs-open" title="Fullscreen edit" aria-label="Fullscreen edit">${icon('maximize', { size: 16 })}</button>`
  return `<div class="cmp-label cmp-label-row">Glass pages<span class="cmp-actions"><button class="gear-btn" data-action="layout-edit-toggle" title="Edit layout" aria-label="Edit layout">${icon('layout', { size: 16 })}</button>${fsBtn}</span></div>
    ${renderPageTabs(pages)}
    <div class="gpv"><div class="gpv-cap">G2 576×288${multi ? ` — page ${ctx.pageEditingIdx + 1}/${pages.length}` : ''}</div><div class="gpv-screen">${glassPreviewHtml()}</div></div>
    <div class="cmp-sub">Glass gestures: swipe = next/prev page / tap = first page / double-tap = exit</div>`
}

// ── Home source カードの swipe-to-delete (iOS 風) ──
// 前面(.swipe-fg)を左へドラッグして背面の🗑(remove-from-preset)を露出する。1枚だけ開く。
// 縦スクロール/タップと衝突しないよう、ドミナント軸が横と確定したときだけ preventDefault する。
const SWIPE_ACTION_W = 72 // 露出する🗑の幅(px)
const SWIPE_SLOP = 8 // この px 動くまで軸を確定しない(タップ誤爆防止)
export const swipeState = { openSrc: null as string | null, endedAt: 0 }
// swipe 終了時刻。直後(<350ms)の click を遷移にしない。永続フラグだと iOS で touchmove preventDefault 時に
// synthetic click が出ず次の正当タップを食うため、時間窓で判定する(自動失効=trash タップを邪魔しない)。
type SwipeDrag = {
  src: string
  fg: HTMLElement
  startX: number
  startY: number
  baseX: number
  axis: '' | 'x' | 'y'
  lastX: number
}
let swipeDrag: SwipeDrag | null = null

// 開いているカードだけ transform を当てる(再描画後の復元にも使う)。
export function applySwipeOpen(): void {
  if (!ctx.root) return
  for (const fg of ctx.root.querySelectorAll<HTMLElement>('.swipe-row > .swipe-fg')) {
    const src = (fg.parentElement as HTMLElement | null)?.dataset.src ?? ''
    fg.style.transform = src && src === swipeState.openSrc ? `translateX(-${SWIPE_ACTION_W}px)` : ''
  }
}
export function closeSwipe(): void {
  if (swipeState.openSrc == null) return
  swipeState.openSrc = null
  applySwipeOpen()
}

export function onSwipeStart(e: TouchEvent): void {
  const fg = (e.target as HTMLElement).closest<HTMLElement>(
    '.swipe-row[data-swipeable] > .swipe-fg',
  )
  if (!fg) {
    closeSwipe() // カード外(やヘッダ)を触ったら閉じる
    return
  }
  const src = (fg.parentElement as HTMLElement).dataset.src ?? ''
  const tch = e.touches[0]
  if (!tch) return
  fg.style.transition = 'none'
  swipeDrag = {
    src,
    fg,
    startX: tch.clientX,
    startY: tch.clientY,
    baseX: swipeState.openSrc === src ? -SWIPE_ACTION_W : 0,
    axis: '',
    lastX: swipeState.openSrc === src ? -SWIPE_ACTION_W : 0,
  }
}
export function onSwipeMove(e: TouchEvent): void {
  const d = swipeDrag
  const tch = e.touches[0]
  if (!d || !tch) return
  const dx = tch.clientX - d.startX
  const dy = tch.clientY - d.startY
  if (d.axis === '') {
    if (Math.abs(dx) > SWIPE_SLOP && Math.abs(dx) > Math.abs(dy)) d.axis = 'x'
    else if (Math.abs(dy) > SWIPE_SLOP)
      d.axis = 'y' // 縦 = スクロールに譲る(以降無視)
    else return
  }
  if (d.axis !== 'x') return
  e.preventDefault() // 横スワイプ確定 → 縦スクロール抑止
  if (swipeState.openSrc && swipeState.openSrc !== d.src) {
    // 別のカードが開いていたら閉じてからこのカードを操作する
    swipeState.openSrc = null
    applySwipeOpen()
    d.baseX = 0
  }
  const x = Math.max(-SWIPE_ACTION_W, Math.min(0, d.baseX + dx)) // 左方向のみ・0..-W にクランプ
  d.lastX = x
  d.fg.style.transform = `translateX(${x}px)`
}
export function onSwipeEnd(): void {
  const d = swipeDrag
  swipeDrag = null
  if (!d) return
  d.fg.style.transition = '' // CSS の snap transition を戻す
  if (d.axis !== 'x') return // タップ or 縦スクロールだった → click 処理に委ねる
  swipeState.endedAt = Date.now() // 直後の click を遷移にしない (時間窓判定)
  swipeState.openSrc = d.lastX < -SWIPE_ACTION_W / 2 ? d.src : null // 半分超で開く、未満で閉じる
  applySwipeOpen()
}

// ── ドラッグ並べ替え ──
let sortables: Sortable[] = []
export function attachSortables(): void {
  for (const s of sortables) s.destroy()
  sortables = []
  const list = document.getElementById('source-list')
  if (list) {
    sortables.push(
      Sortable.create(list, {
        handle: '.src-grip',
        animation: 150,
        delay: 200,
        delayOnTouchOnly: true, // タッチは長押しでドラッグ開始 (素早いスワイプはスクロール)
        onEnd: (e) => onGroupReorder(e.oldIndex, e.newIndex),
      }),
    )
  }
  for (const el of document.querySelectorAll<HTMLElement>('.src-metrics')) {
    const key = el.dataset.key ?? ''
    sortables.push(
      Sortable.create(el, {
        handle: '.mgrip',
        animation: 150,
        delay: 200,
        delayOnTouchOnly: true,
        onEnd: (e) => onSegReorder(key, e.oldIndex, e.newIndex),
      }),
    )
  }
  // WYSIWYG: 固定行セル + 棚を跨いで segment chip をドラッグ (共有 group)。
  // forceFallback: iOS WKWebView では HTML5 DnD が touch で動かないため必須。
  // delayOnTouchOnly: タッチは長押しでドラッグ開始 (素早いスワイプはスクロールに通す)。
  // drag 中はドロップ先セルをハイライト。
  if (ctx.layoutEditing) {
    for (const el of document.querySelectorAll<HTMLElement>('.wys-cell')) {
      sortables.push(
        Sortable.create(el, {
          group: 'wys',
          handle: '.wys-grip',
          animation: 150,
          delay: 200,
          delayOnTouchOnly: true,
          forceFallback: true,
          onMove: (evt) => {
            for (const c of document.querySelectorAll('.wys-cell.drop-hot')) {
              c.classList.remove('drop-hot')
            }
            evt.to?.classList.add('drop-hot')
            return true
          },
          onEnd: () => {
            for (const c of document.querySelectorAll('.wys-cell.drop-hot')) {
              c.classList.remove('drop-hot')
            }
            recomputeFromDom()
          },
        }),
      )
    }
  }
}

// DOM の行ゾーン (data-row/data-zone) から chip キー列を読む。
function readZone(i: number, zone: 'left' | 'right'): string[] {
  const el = document.querySelector<HTMLElement>(`.wys-cell[data-row="${i}"][data-zone="${zone}"]`)
  if (!el) return []
  return [...el.querySelectorAll<HTMLElement>('.wys-chip')]
    .map((c) => c.dataset.segkey ?? '')
    .filter(Boolean)
}

// DOM の行ゾーンから rows (n 行) を再構築する。右ゾーンに chip があれば @right 区切りを挿む。
function readRowsFromDom(n: number): string[][] {
  return Array.from({ length: n }, (_, i) => {
    const left = readZone(i, 'left')
    const right = readZone(i, 'right')
    return right.length ? [...left, RIGHT_DIVIDER, ...right] : left
  })
}

// ドラッグ後の書き戻し: grid セル行エディタ (#grid-rows) があればそのセルへ、無ければ線形 layout へ。
function recomputeFromDom(): void {
  const gridRows = document.querySelector<HTMLElement>('#grid-rows')
  if (gridRows) {
    recomputeGridCellFromDom(gridRows.dataset.cellId ?? '')
    return
  }
  recomputeWysFromDom()
}

// grid 選択セルの行を DOM から再構築する (行数 = セル容量)。
function recomputeGridCellFromDom(cellId: string): void {
  const page = activeView(ctx.config).pages?.[ctx.pageEditingIdx]
  const cell = page?.grid?.cells.find((c) => c.id === cellId)
  if (!cell) return
  cell.rows = readRowsFromDom(cellCapacity(cell))
  void saveConfig(ctx.config)
  requestRender()
}

// ドラッグ後、各行の左/右ゾーンの chip 並びから glassLayout.rows (固定 MAX_ROWS 行) を再構築する。
// 棚 (data-shelf) の chip はどの行にも無い = 未配置 (次の描画で棚に導出される)。
function recomputeWysFromDom(): void {
  const lay = editingLayout()
  if (!lay) return
  const page = activeView(ctx.config).pages?.[ctx.pageEditingIdx]
  if (page) page.layout = { rows: readRowsFromDom(MAX_ROWS), customLabels: lay.customLabels }
  void saveConfig(ctx.config)
  requestRender()
}

// active view の groupOrder を並べ替える。indices は visibleRefs (実在 group) 基準。非表示 ref は温存。
function onGroupReorder(oldIndex?: number, newIndex?: number): void {
  if (oldIndex == null || newIndex == null || oldIndex === newIndex) return
  const view = activeView(ctx.config)
  const visible = visibleRefs()
  const [moved] = visible.splice(oldIndex, 1)
  if (!moved) return
  visible.splice(newIndex, 0, moved)
  const rest = view.groupOrder.filter((r) => !statusGroup(r.sourceId, r.groupId))
  view.groupOrder = [...visible, ...rest]
  void saveConfig(ctx.config)
  requestPreviewUpdate()
}

// segment の並び順は素材 (GroupMeta.segments) に持つ (全 profile 共通の順序基準)。
function onSegReorder(key: string, oldIndex?: number, newIndex?: number): void {
  const ref = parseKey(key)
  const meta = ctx.config.groups[ref.sourceId]?.[ref.groupId]
  if (!meta || oldIndex == null || newIndex == null || oldIndex === newIndex) return
  const [moved] = meta.segments.splice(oldIndex, 1)
  if (!moved) return
  meta.segments.splice(newIndex, 0, moved)
  void saveConfig(ctx.config)
  requestPreviewUpdate()
}
