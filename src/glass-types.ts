// glass 表示の定数 (純粋 leaf、他モジュールを import しない)。
// glass-render(描画) / glass-layout(grid compiler) / config(レイアウト正規化) が参照する共有基盤。
// ここを leaf 化することで config → glass-render、glass-render → glass-layout の循環依存を断つ。

// 288px / line-height 27px ≒ 10 行。glass の表示可能行数 (companion の行数上限にも使う)。
export const MAX_ROWS = 10

// G2 ディスプレイ寸法と TextContainer padding (glass.ts の TextContainerProperty と一致させる)。
export const GLASS_WIDTH = 576
export const GLASS_HEIGHT = 288
export const GLASS_PADDING = 8

// grid レイアウトの論理格子 (Issue #17)。COL_W=48px / ROW_H=28.8px に対応する。
// compiler (glass-layout) と config 正規化 (config/layout) の双方が参照する。
export const GRID_COLS = 12
export const GRID_ROWS = 10

// glass の line-height (px)。compiler の fitContent / セル行容量の共通基盤。
export const LINE_H = 27

// image cell (Issue #17) の SDK 制約 (ImageContainerProperty): width 20-288 / height 20-144 px、
// 1 ページ最大 4 枚。containerID は text (1-8) / overlay dot (90+) と衝突しないレンジを使う。
export const IMAGE_MIN_PX = 20
export const IMAGE_MAX_W = 288
export const IMAGE_MAX_H = 144
export const IMAGE_CELL_MAX = 4
export const IMAGE_CONTAINER_ID_BASE = 30

// image cell の icon 語彙 (glass 描画用の curated set)。描画実体は glass-image.ts が持つ。
// config 正規化は語彙の存在だけを見る (leaf に置いて config → canvas 依存を作らない)。
export const GLASS_ICON_NAMES = [
  'battery',
  'clock',
  'cpu',
  'thermometer',
  'sun',
  'moon',
  'cloud',
  'zap',
  'heart',
  'home',
] as const
export type GlassIconName = (typeof GLASS_ICON_NAMES)[number]

// grid セルの行容量。edge-based 丸め (compiler の cellRect と同式) の高さから
// border/padding の inset を引いた行数。描画 (glass-render) / エディタ (companion) /
// 正規化 (config) が同じ式を使う — ずれると「描画されないのに配置済み」の chip が
// 棚にも出ず silent loss になる。
export function cellRowCapacity(c: {
  row: number
  rowSpan: number
  border?: number
  padding?: number
}): number {
  const rowH = GLASS_HEIGHT / GRID_ROWS
  const y = Math.round(c.row * rowH)
  const h = Math.round((c.row + c.rowSpan) * rowH) - y
  const inset = 2 * ((c.border ?? 0) + (c.padding ?? 0))
  return Math.max(1, Math.floor((h - inset) / LINE_H))
}
