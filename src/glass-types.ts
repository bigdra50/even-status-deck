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
