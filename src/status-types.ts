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
  /** glass 表示枠の最大桁数。短ければ pad で枠確保、超えれば … で省略。builtin のみ設定 (server は undefined=無加工)。 */
  widthChars?: number
  /** true なら数値系として右寄せ pad。builtin のみ設定 (server は false 相当=左寄せ)。 */
  isNumeric?: boolean
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

// 巨大入力で iOS WKWebView の WebContent を圧迫 (白画面=jettison) させないためのサニタイズ上限。
// 接続先サーバ (ユーザー設定の URL) の異常出力 1 回で巨大 DOM/文字列を生成させない。
// glass は 576×288・10 行・約 50 桁/行なので、表示上もこれらは十分すぎる緩い上限。
const MAX_GROUPS = 24
const MAX_SEGMENTS = 24
const MAX_ID_LEN = 64 // 異常に長い id はキーを汚すため破棄 (truncate でキー衝突させない)
const MAX_LABEL_LEN = 48 // 表示ラベル (1 行に収まる範囲)
const MAX_VALUE_LEN = 128 // 表示値 (server は widthChars 無しで raw 長が幅計算に乗る)
const MAX_RESET_LEN = 32

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

// 受信 JSON を検証・サニタイズして StatusDoc を返す。3rd party サーバーの不正データで
// 描画を壊さないため、不正 group/segment は破棄し、想定外フィールドも落とす。
// group/segment 数と文字列長に上限を設け、巨大入力でフットプリントが膨れないようにする。
// 致命的に壊れている (object でない / version なし / groups が配列でない) 場合は null。
export function parseStatusDoc(x: unknown): StatusDoc | null {
  if (!x || typeof x !== 'object') return null
  const d = x as Record<string, unknown>
  if (typeof d.version !== 'number' || !Array.isArray(d.groups)) return null
  const groups: Group[] = []
  for (const g of d.groups) {
    if (groups.length >= MAX_GROUPS) break
    if (!g || typeof g !== 'object') continue
    const gg = g as Record<string, unknown>
    if (typeof gg.id !== 'string' || typeof gg.label !== 'string' || !Array.isArray(gg.segments)) {
      continue
    }
    if (gg.id.length > MAX_ID_LEN) continue
    const segments: Segment[] = []
    for (const s of gg.segments) {
      if (segments.length >= MAX_SEGMENTS) break
      if (!s || typeof s !== 'object') continue
      const ss = s as Record<string, unknown>
      if (
        typeof ss.id !== 'string' ||
        typeof ss.label !== 'string' ||
        typeof ss.value !== 'string'
      ) {
        continue
      }
      if (ss.id.length > MAX_ID_LEN) continue
      const seg: Segment = {
        id: ss.id,
        label: clip(ss.label, MAX_LABEL_LEN),
        value: clip(ss.value, MAX_VALUE_LEN),
      }
      if (typeof ss.percent === 'number') seg.percent = ss.percent
      if (typeof ss.reset === 'string') seg.reset = clip(ss.reset, MAX_RESET_LEN)
      if (typeof ss.defaultEnabled === 'boolean') seg.defaultEnabled = ss.defaultEnabled
      segments.push(seg)
    }
    groups.push({ id: gg.id, label: clip(gg.label, MAX_LABEL_LEN), segments })
  }
  return { version: d.version, ts: typeof d.ts === 'number' ? d.ts : Date.now(), groups }
}
