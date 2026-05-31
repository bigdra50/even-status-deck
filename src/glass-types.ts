// glass 表示の行数定数 (純粋 leaf、他モジュールを import しない)。
// glass-render(描画) と config(レイアウト正規化) の双方が参照する共有基盤。
// ここを leaf 化することで config → glass-render の循環依存を断つ。

// 288px / line-height 27px ≒ 10 行。glass の表示可能行数 (companion の行数上限にも使う)。
export const MAX_ROWS = 10
