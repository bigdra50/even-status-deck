// glass layout / grid ページ編集 (Issue #17) の click ハンドラ。actions.ts の CLICK_ACTIONS に合流する。
// state/render-port/sync/grid-edit/fs-editor と config に依存。
import {
  activeView,
  BUILTIN_SOURCE_ID,
  customLabelKey,
  generateGlassLayout,
  genLabelId,
  genPageId,
  saveConfig,
} from '../config'
import { openFsEditor } from './fs-editor'
import { canPlace, cellCapacity, findFreeRect, nextCellId } from './grid-edit'
import { requestRender } from './render-port'
import { ctx } from './state'
import { editingLayout, editingPage, emptyGlassLayout } from './sync'

type ClickHandler = (t: HTMLElement, e: MouseEvent) => void | Promise<void>

// 編集中ページの grid と選択セル (grid エディタの操作対象)。
function editingGridCell(): {
  grid: NonNullable<ReturnType<typeof editingPage>>['grid']
  cell:
    | NonNullable<NonNullable<ReturnType<typeof editingPage>>['grid']>['cells'][number]
    | undefined
} {
  const grid = editingPage()?.grid
  const cell = grid?.cells.find((c) => c.id === ctx.gridCellSel)
  return { grid, cell }
}

export const LAYOUT_CLICK_ACTIONS: Record<string, ClickHandler> = {
  // ── layout / page editing ──
  'layout-edit-toggle'() {
    ctx.layoutEditing = !ctx.layoutEditing
    requestRender()
  },
  'layout-customize'() {
    // auto → explicit: 現在の groupOrder から 1 ページ目を生成して編集モードへ。
    activeView(ctx.config).pages = [
      { id: genPageId(), name: 'Page 1', layout: generateGlassLayout(ctx.config) },
    ]
    ctx.pageEditingIdx = 0
    ctx.layoutEditing = true // 生成と同時に編集モードへ
    void saveConfig(ctx.config)
    requestRender()
  },
  'layout-reset'() {
    // explicit → auto: 全ページと legacy glassLayout を破棄して自動デッキへ戻す。
    const view = activeView(ctx.config)
    view.pages = undefined
    view.glassLayout = undefined
    ctx.pageEditingIdx = 0
    ctx.gridCellSel = null
    ctx.layoutEditing = false
    void saveConfig(ctx.config)
    requestRender()
  },
  'fs-open'() {
    // フルスクリーン WYSIWYG エディタ (実験的)。explicit デッキ未生成なら 1 ページ目を作って開く。
    const view = activeView(ctx.config)
    if (!view.pages?.length) {
      view.pages = [{ id: genPageId(), name: 'Page 1', layout: generateGlassLayout(ctx.config) }]
      ctx.pageEditingIdx = 0
      void saveConfig(ctx.config)
    }
    openFsEditor()
  },
  'layout-item-remove'(t) {
    // segment を全行から外す → 未配置 (Unplaced 棚) に導出される。grid ページではセル行から外す。
    const key = t.dataset.segkey
    if (!key) return
    const page = editingPage()
    if (page?.mode === 'grid' && page.grid) {
      for (const c of page.grid.cells) c.rows = c.rows.map((r) => r.filter((k) => k !== key))
    } else {
      const lay = editingLayout()
      if (!lay) return
      lay.rows = lay.rows.map((r) => r.filter((k) => k !== key))
    }
    void saveConfig(ctx.config)
    requestRender()
  },
  'label-add'() {
    // 任意テキストのラベルを作成 (未配置棚に出る)。inline input から読む。
    // grid ページでもラベル本文の置き場は page.layout.customLabels (共有ストア)。
    const input = ctx.root?.querySelector<HTMLInputElement>('.lay-add-input')
    const text = (input?.value ?? '').trim().slice(0, 64)
    const lay = editingLayout()
    if (lay && text) {
      lay.customLabels[genLabelId()] = { text }
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'label-delete'(t) {
    // custom ラベルを完全削除 (customLabels から除去 + 全 rows / grid セル行の参照を除去)。
    const id = t.dataset.labelId
    const lay = editingLayout()
    if (lay && id) {
      delete lay.customLabels[id]
      const k = customLabelKey(id)
      lay.rows = lay.rows.map((r) => r.filter((x) => x !== k))
      const grid = editingPage()?.grid
      if (grid) for (const c of grid.cells) c.rows = c.rows.map((r) => r.filter((x) => x !== k))
      void saveConfig(ctx.config)
      requestRender()
    }
  },

  // ── grid ページ編集 (Issue #17) ──
  'page-mode-toggle'() {
    const page = editingPage()
    if (!page) return
    if (page.mode === 'grid') {
      // grid → rows: mode を外すだけ (grid 定義は温存 = 再切替で配置が戻る。layout は凍結スナップショット)。
      page.mode = undefined
    } else {
      page.grid ??= { cells: [] }
      page.mode = 'grid'
    }
    ctx.gridCellSel = null
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-select'(t) {
    const id = t.dataset.cellId ?? null
    ctx.gridCellSel = ctx.gridCellSel === id ? null : id // 再タップで解除
    requestRender()
  },
  'grid-cell-add'() {
    const grid = editingPage()?.grid
    if (!grid || grid.cells.length >= 7) return
    const rect = findFreeRect(grid)
    if (!rect) return
    const id = nextCellId(grid)
    grid.cells.push({ id, ...rect, rows: [] })
    ctx.gridCellSel = id
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-remove'() {
    const grid = editingPage()?.grid
    if (!grid || !ctx.gridCellSel) return
    // セルごと削除 (中の chip は未配置棚に導出される)。
    grid.cells = grid.cells.filter((c) => c.id !== ctx.gridCellSel)
    ctx.gridCellSel = null
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-move'(t) {
    const { grid, cell } = editingGridCell()
    if (!grid || !cell) return
    const next = {
      ...cell,
      col: cell.col + Number(t.dataset.dx ?? 0),
      row: cell.row + Number(t.dataset.dy ?? 0),
    }
    if (!canPlace(grid, next, cell.id)) return
    cell.col = next.col
    cell.row = next.row
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-resize'(t) {
    const { grid, cell } = editingGridCell()
    if (!grid || !cell) return
    const delta = Number(t.dataset.delta ?? 0)
    const next = { ...cell }
    if (t.dataset.dim === 'w') next.colSpan += delta
    else next.rowSpan += delta
    if (!canPlace(grid, next, cell.id)) return
    cell.colSpan = next.colSpan
    cell.rowSpan = next.rowSpan
    // 縮んで容量を超えた行は棚に戻す (隠れた行に chip が残ると見えないまま温存される)。
    cell.rows = cell.rows.slice(0, cellCapacity(cell))
    // 1 行になったら枠線は無効 (normalize と同じ規則)。
    if (cell.rowSpan < 2) cell.border = undefined
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-cell-border'() {
    const { cell } = editingGridCell()
    if (!cell || cell.rowSpan < 2) return
    cell.border = cell.border ? undefined : 1
    // 枠線で容量が減ることがある (padding 併用時)。超過行は棚に戻す (隠れ行の silent loss 防止)。
    cell.rows = cell.rows.slice(0, cellCapacity(cell))
    void saveConfig(ctx.config)
    requestRender()
  },
  'grid-chip-add'(t) {
    // 棚の chip をタップで選択中セルの空きがある最初の行へ追加する (drag の代替。e2e でも安定)。
    const key = t.dataset.segkey
    const { cell } = editingGridCell()
    if (!cell || !key || cell.kind === 'image') return // image cell は rows を持たない
    // 空行があればそこへ、無ければ容量内で行を増やし、満杯なら最後の行へ相乗りする。
    const cap = cellCapacity(cell)
    const empty = cell.rows.findIndex((r) => r.length === 0)
    if (empty >= 0) cell.rows[empty]?.push(key)
    else if (cell.rows.length < cap) cell.rows.push([key])
    else cell.rows[cell.rows.length - 1]?.push(key)
    void saveConfig(ctx.config)
    requestRender()
  },
  'page-select'(t) {
    const i = Number(t.dataset.pageIdx)
    const pages = activeView(ctx.config).pages
    if (pages && Number.isInteger(i) && i >= 0 && i < pages.length) {
      ctx.pageEditingIdx = i
      // 別ページにも同名セル (cell1 等) があり得るため、選択は持ち越さない。
      ctx.gridCellSel = null
      requestRender()
    }
  },
  'page-add'() {
    const view = activeView(ctx.config)
    view.pages ??= []
    view.pages.push({
      id: genPageId(),
      name: `Page ${view.pages.length + 1}`,
      layout: emptyGlassLayout(),
    })
    ctx.pageEditingIdx = view.pages.length - 1
    ctx.gridCellSel = null
    ctx.layoutEditing = true
    void saveConfig(ctx.config)
    requestRender()
  },
  'page-remove'() {
    const pages = activeView(ctx.config).pages
    if (pages && pages.length > 1 && ctx.pageEditingIdx < pages.length) {
      pages.splice(ctx.pageEditingIdx, 1)
      if (ctx.pageEditingIdx >= pages.length) ctx.pageEditingIdx = pages.length - 1
      // index 詰めで別ページが繰り上がる。同名セル (cell1 等) の誤選択を防ぐ。
      ctx.gridCellSel = null
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'page-move-up'() {
    const pages = activeView(ctx.config).pages
    const i = ctx.pageEditingIdx
    const a = pages?.[i - 1]
    const b = pages?.[i]
    if (pages && a && b && i > 0) {
      pages[i - 1] = b
      pages[i] = a
      ctx.pageEditingIdx = i - 1
      void saveConfig(ctx.config)
      requestRender()
    }
  },
  'page-move-down'() {
    const pages = activeView(ctx.config).pages
    const i = ctx.pageEditingIdx
    const a = pages?.[i]
    const b = pages?.[i + 1]
    if (pages && a && b && i < pages.length - 1) {
      pages[i] = b
      pages[i + 1] = a
      ctx.pageEditingIdx = i + 1
      void saveConfig(ctx.config)
      requestRender()
    }
  },

  // ── misc (実機検証用) ──
  'dbg-img-probe'() {
    // 実機検証用: icon + sparkline (グラス電池) の image cell を持つ grid ページを 1 枚追加する。
    // 通常パイプライン (rebuild → updateImageRawData) を通すので、PNG 受理 / gray4 変換を
    // そのまま確認できる。不要になったらページ削除 UI で消す。
    const view = activeView(ctx.config)
    view.pages ??= []
    view.pages.push({
      id: genPageId(),
      name: 'Img probe',
      layout: emptyGlassLayout(),
      mode: 'grid',
      grid: {
        cells: [
          {
            id: 'probetitle',
            col: 0,
            row: 0,
            colSpan: 12,
            rowSpan: 1,
            rows: [[`${BUILTIN_SOURCE_ID}|clock|datetime`]],
          },
          {
            id: 'probeicon',
            col: 0,
            row: 2,
            colSpan: 3,
            rowSpan: 3,
            rows: [],
            kind: 'image',
            image: { source: 'icon', icon: 'battery' },
          },
          {
            id: 'probespark',
            col: 4,
            row: 2,
            colSpan: 6,
            rowSpan: 3,
            rows: [],
            kind: 'image',
            image: { source: 'sparkline', segKey: `${BUILTIN_SOURCE_ID}|g2|level` },
          },
        ],
      },
    })
    void saveConfig(ctx.config)
    requestRender()
  },
}
