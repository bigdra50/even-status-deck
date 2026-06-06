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
import { icon } from '../icons'
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

export function rowOverflow(items: string[]): boolean {
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
  return total + Math.max(0, n - 1) * 2 > ROW_MAX_CHARS
}

// WYSIWYG の chip。custom ラベル (自由テキスト) と segment 値 chip の 2 種。
// 値 chip は実機の表示文字列 (label value / value)。group の default-label が ON なら
// group 名を小さく添える (実機で前置されるラベルを editor で可視化。OFF なら出さない)。
function wysChip(key: string): string {
  const grip = `<span class="wys-grip">${icon('grip', { size: 11 })}</span>`
  // custom ラベル: × は削除 (customLabels から除去)。値 chip の × は unplace。
  if (isCustomLabelKey(key)) {
    const id = customLabelId(key)
    const text = editingLayout()?.customLabels[id]?.text ?? ''
    const del = `<button class="wys-x" data-action="label-delete" data-label-id="${esc(id)}" title="Delete label" aria-label="Delete label">${icon('x', { size: 10 })}</button>`
    return `<span class="wys-chip wys-label-chip wys-custom-chip" data-segkey="${esc(key)}" title="${esc(text)}">${grip}<span class="wys-txt">${esc(text)}</span>${del}</span>`
  }
  const [sourceId, groupId, segId] = key.split('|')
  const { group, seg } = segLabelParts(key)
  const x = `<button class="wys-x" data-action="layout-item-remove" data-segkey="${esc(key)}" aria-label="Unplace">${icon('x', { size: 10 })}</button>`
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
  return `<span class="wys-chip" data-segkey="${esc(key)}" title="${esc(group ? `${group} ${seg}` : seg)}">${grip}${grp}${ownerBadge}<span class="wys-txt">${esc(text)}</span>${x}</span>`
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
    const lc = left.map(wysChip).join('')
    const rc = right.map(wysChip).join('')
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
    ? unplaced.map(wysChip).join('')
    : '<span class="cmp-sub">Nothing unplaced</span>'
  return `<div class="gpv"><div class="gpv-cap">G2 576×288 — editing</div>
      <div class="gpv-screen wys-screen">${lines.join('')}</div></div>
    <div class="cmp-sub">Drag items into the left or right side of a row. Right-side items align to the right edge.</div>
    <div class="cmp-label">Unplaced</div>
    <div class="wys-cell wys-shelf" data-shelf="1">${shelf}</div>
    <div class="field-row wys-add">
      <input class="lay-add-input" type="text" maxlength="64" placeholder="Custom label (heading / divider …)" />
      <button class="save-btn sm" data-action="label-add">${icon('plus', { size: 14 })}Add label</button>
    </div>
    <button class="danger-btn" data-action="layout-reset">Reset to auto</button>`
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
      return `<button class="page-tab${active}" data-action="page-select" data-page-idx="${i}" title="${esc(p.name)}">${esc(p.name)}</button>`
    })
    .join('')
  const add = `<button class="page-tab page-add" data-action="page-add" title="Add page" aria-label="Add page">${icon('plus', { size: 14 })}</button>`
  return `<div class="page-tabs">${tabs}${add}</div>`
}

// 編集中ページ (pageEditingIdx) の操作行: 名前 rename / 左右移動 / 削除。
function renderPageControls(pages: GlassPage[]): string {
  const cur = pages[ctx.pageEditingIdx]
  if (!cur) return ''
  const up = ctx.pageEditingIdx === 0 ? 'disabled' : ''
  const down = ctx.pageEditingIdx >= pages.length - 1 ? 'disabled' : ''
  const del = pages.length <= 1 ? 'disabled' : ''
  return `<div class="page-ctl">
      <input class="page-name-input" type="text" maxlength="24" value="${esc(cur.name)}" data-action="page-rename" data-page-idx="${ctx.pageEditingIdx}" placeholder="Page name" aria-label="Page name" />
      <button class="gear-btn" data-action="page-move-up" title="Move left" aria-label="Move left" ${up}>${icon('chevron-left', { size: 14 })}</button>
      <button class="gear-btn" data-action="page-move-down" title="Move right" aria-label="Move right" ${down}>${icon('chevron-right', { size: 14 })}</button>
      <button class="gear-btn danger" data-action="page-remove" title="Delete page" aria-label="Delete page" ${del}>${icon('trash', { size: 14 })}</button>
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
  const lay = pages[ctx.pageEditingIdx]?.layout ?? pages[0].layout
  const multi = pages.length > 1
  if (ctx.layoutEditing) {
    return `<div class="cmp-label cmp-label-row">Glass pages<button class="gear-btn" data-action="layout-edit-toggle" title="Done" aria-label="Done">${icon('check', { size: 16 })}</button></div>
      ${renderPageTabs(pages)}
      ${renderPageControls(pages)}
      <div class="cmp-sub">Drag items to rows (1–${MAX_ROWS}) or the Unplaced shelf. Row number = position from top of glass.</div>
      ${renderGlassEdit(lay)}`
  }
  return `<div class="cmp-label cmp-label-row">Glass pages<span class="cmp-actions"><button class="gear-btn" data-action="layout-edit-toggle" title="Edit layout" aria-label="Edit layout">${icon('layout', { size: 16 })}</button><button class="gear-btn" data-action="fs-open" title="Fullscreen edit" aria-label="Fullscreen edit">${icon('maximize', { size: 16 })}</button></span></div>
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
            recomputeWysFromDom()
          },
        }),
      )
    }
  }
}

// ドラッグ後、各行の左/右ゾーンの chip 並びから glassLayout.rows (固定 MAX_ROWS 行) を再構築する。
// 右ゾーンに chip があれば左ゾーンとの間に @right 区切りを挿む (前=左/後=右クラスタ)。
// 棚 (data-shelf) の chip はどの行にも無い = 未配置 (次の描画で棚に導出される)。
function recomputeWysFromDom(): void {
  const lay = editingLayout()
  if (!lay) return
  const readZone = (i: number, zone: 'left' | 'right'): string[] => {
    const el = document.querySelector<HTMLElement>(
      `.wys-cell[data-row="${i}"][data-zone="${zone}"]`,
    )
    if (!el) return []
    return [...el.querySelectorAll<HTMLElement>('.wys-chip')]
      .map((c) => c.dataset.segkey ?? '')
      .filter(Boolean)
  }
  const rows: string[][] = Array.from({ length: MAX_ROWS }, (_, i) => {
    const left = readZone(i, 'left')
    const right = readZone(i, 'right')
    return right.length ? [...left, RIGHT_DIVIDER, ...right] : left
  })
  const page = activeView(ctx.config).pages?.[ctx.pageEditingIdx]
  if (page) page.layout = { rows, customLabels: lay.customLabels }
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
