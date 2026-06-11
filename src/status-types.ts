// /api/status のワイヤ型。サーバー (vite.config.ts) とクライアント (data.ts 等) で共有する。
// サーバーが provider 群を集約して segment を提供し、クライアントは汎用に描画する
// (status line 型のモジュラー構成)。

// ソース報告の鮮度/障害状態 (PROTOCOL §3)。transport 鮮度 (§6, client が status doc を取得できているか)
// とは別軸で、「ソースは生きているが upstream が degraded」を表す。未指定は 'ok'。
// 'stale' = value は最後の既知値 (最新ではない)、'error' = upstream 取得失敗 (value は n/a 等)。
export type SourceState = 'ok' | 'stale' | 'error'

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
  /** segment 単位の状態 (PROTOCOL §3)。group.state を上書きする。 */
  state?: SourceState
  /** state の補助メッセージ (companion の tooltip 等。glass には出さない)。 */
  message?: string
}

export type Group = {
  id: string
  label: string
  segments: Segment[]
  /** group 単位の状態 (PROTOCOL §3)。segment.state が無い segment はこれを継承する。 */
  state?: SourceState
  /** state の補助メッセージ。 */
  message?: string
  /** 描画時刻に依存する segment の再計算 anchor (#38 weather の sun epoch 等)。数値のみ。glass が毎分読む。 */
  anchors?: Record<string, number>
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
const MAX_ANCHORS = 8 // group.anchors の数値キー上限 (#38 sun epoch 等。巨大マップを注入させない)
const MAX_MESSAGE_LEN = 120 // state の補助メッセージ (companion tooltip 1 行に収まる範囲)

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

function asState(v: unknown): SourceState | undefined {
  return v === 'ok' || v === 'stale' || v === 'error' ? v : undefined
}

// segment 1件を検証・サニタイズする。id/label/value のいずれかが欠落・型違いなら null (= 破棄)。
function parseSegment(s: unknown): Segment | null {
  if (!s || typeof s !== 'object') return null
  const ss = s as Record<string, unknown>
  if (typeof ss.id !== 'string' || typeof ss.label !== 'string' || typeof ss.value !== 'string') {
    return null
  }
  if (ss.id.length > MAX_ID_LEN) return null
  const seg: Segment = {
    id: ss.id,
    label: clip(ss.label, MAX_LABEL_LEN),
    value: clip(ss.value, MAX_VALUE_LEN),
  }
  if (typeof ss.percent === 'number') seg.percent = ss.percent
  if (typeof ss.reset === 'string') seg.reset = clip(ss.reset, MAX_RESET_LEN)
  if (typeof ss.defaultEnabled === 'boolean') seg.defaultEnabled = ss.defaultEnabled
  const segState = asState(ss.state)
  if (segState) seg.state = segState
  if (typeof ss.message === 'string') seg.message = clip(ss.message, MAX_MESSAGE_LEN)
  return seg
}

// group.segments を検証・サニタイズし、MAX_SEGMENTS 件で打ち切る。
function parseSegments(raw: unknown[]): Segment[] {
  const segments: Segment[] = []
  for (const s of raw) {
    if (segments.length >= MAX_SEGMENTS) break
    const seg = parseSegment(s)
    if (seg) segments.push(seg)
  }
  return segments
}

// group.anchors (#38): 数値のみの小さなマップ。weather cache の readback で sun epoch を保持する
// (落とすと reload 後に suncountdown が次の weather 再取得まで固まる)。
// MAX_ANCHORS 件で打ち切り、空なら undefined (group.anchors を未設定にする)。
function parseAnchors(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const a: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(a).length >= MAX_ANCHORS) break
    if (typeof v === 'number' && Number.isFinite(v) && k.length <= MAX_ID_LEN) a[k] = v
  }
  return Object.keys(a).length ? a : undefined
}

// group 1件を検証・サニタイズする。id/label/segments のいずれかが欠落・型違いなら null (= 破棄)。
function parseGroup(g: unknown): Group | null {
  if (!g || typeof g !== 'object') return null
  const gg = g as Record<string, unknown>
  if (typeof gg.id !== 'string' || typeof gg.label !== 'string' || !Array.isArray(gg.segments)) {
    return null
  }
  if (gg.id.length > MAX_ID_LEN) return null
  const group: Group = {
    id: gg.id,
    label: clip(gg.label, MAX_LABEL_LEN),
    segments: parseSegments(gg.segments),
  }
  const grpState = asState(gg.state)
  if (grpState) group.state = grpState
  if (typeof gg.message === 'string') group.message = clip(gg.message, MAX_MESSAGE_LEN)
  const anchors = parseAnchors(gg.anchors)
  if (anchors) group.anchors = anchors
  return group
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
    const group = parseGroup(g)
    if (group) groups.push(group)
  }
  return { version: d.version, ts: typeof d.ts === 'number' ? d.ts : Date.now(), groups }
}
