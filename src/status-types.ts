// /api/status のワイヤ型。サーバー (vite.config.ts) とクライアント (data.ts 等) で共有する。
// サーバーが provider 群を集約して segment を提供し、クライアントは汎用に描画する
// (status line 型のモジュラー構成)。

export type Segment = {
  id: string
  label: string
  /** 表示文字列。サーバー側で整形済み (例 "12%" / "$1775" / "2973" / "n/a")。 */
  value: string
  /** progress bar 用 0-100。省略時は bar を描かない (cost/msgs 等)。 */
  percent?: number
  /** 副次表示。例 reset までの残り "2h13m"。 */
  reset?: string
  /** 初回設定時の既定 ON/OFF。未指定は true 扱い。 */
  defaultEnabled?: boolean
}

export type Group = {
  id: string
  label: string
  segments: Segment[]
}

export type StatusDoc = {
  version: number
  ts: number
  groups: Group[]
}
