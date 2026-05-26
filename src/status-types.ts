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

// 受信 JSON を検証・サニタイズして StatusDoc を返す。3rd party サーバーの不正データで
// 描画を壊さないため、不正 group/segment は破棄し、想定外フィールドも落とす。
// 致命的に壊れている (object でない / version なし / groups が配列でない) 場合は null。
export function parseStatusDoc(x: unknown): StatusDoc | null {
  if (!x || typeof x !== 'object') return null
  const d = x as Record<string, unknown>
  if (typeof d.version !== 'number' || !Array.isArray(d.groups)) return null
  const groups: Group[] = []
  for (const g of d.groups) {
    if (!g || typeof g !== 'object') continue
    const gg = g as Record<string, unknown>
    if (typeof gg.id !== 'string' || typeof gg.label !== 'string' || !Array.isArray(gg.segments)) {
      continue
    }
    const segments: Segment[] = []
    for (const s of gg.segments) {
      if (!s || typeof s !== 'object') continue
      const ss = s as Record<string, unknown>
      if (
        typeof ss.id !== 'string' ||
        typeof ss.label !== 'string' ||
        typeof ss.value !== 'string'
      ) {
        continue
      }
      const seg: Segment = { id: ss.id, label: ss.label, value: ss.value }
      if (typeof ss.percent === 'number') seg.percent = ss.percent
      if (typeof ss.reset === 'string') seg.reset = ss.reset
      if (typeof ss.defaultEnabled === 'boolean') seg.defaultEnabled = ss.defaultEnabled
      segments.push(seg)
    }
    groups.push({ id: gg.id, label: gg.label, segments })
  }
  return { version: d.version, ts: typeof d.ts === 'number' ? d.ts : Date.now(), groups }
}
