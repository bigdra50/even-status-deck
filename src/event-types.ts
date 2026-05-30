// /api/events (long-poll) と POST /api/emit のワイヤ型。サーバーとクライアントで共有する。
// transient overlay イベント (notification / toast / banner) を運ぶ。これは永続状態の
// StatusDoc (status-types.ts) とは別軸: fire-once で、再取得しても再表示しない (client が id で dedupe)。
//
// 方向:
//   provider/watcher → POST /api/emit (loopback) → server buffer → GET /api/events (long-poll) → client
//
// dialog は往復 (onResult) が要るためリモートイベントには含めない (PROTOCOL §10 reserved の /api/action 方向)。

export type OverlayEventKind = 'notification' | 'toast' | 'banner'

// emit 入力。provider/watcher が POST /api/emit に投げる形。seq/ts は server が付与する。
export type EmitInput = {
  /** 発信元 id。dedupe の名前空間 + rate limit の単位。 */
  providerId: string
  /** provider 内で一意。再 emit しても再表示させないための dedupe キー。 */
  id: string
  kind: OverlayEventKind
  /** notification: アプリ名 (例 "Slack")。 */
  app?: string
  /** notification: 送信者/タイトル。 */
  sender?: string
  /** notification: 本文。 */
  body?: string
  /** toast / banner: 表示文字列。 */
  text?: string
  /** toast: 自動消去までの ms。 */
  durationMs?: number
  /** server buffer の保持・client 配送猶予 (ms)。 */
  ttlMs?: number
}

// server が seq (source-local 単調増加) と ts を付与した配送形。
export type OverlayEvent = EmitInput & { seq: number; ts: number }

// GET /api/events のレスポンス。
export type EventsDoc = {
  version: number
  /** 情報用: source の machineId。 */
  sourceId?: string
  /** 次回 since に渡す値 (= buffer の最大 seq)。 */
  cursor: number
  /** since が古すぎて buffer から落ちていた / server 再起動で seq がリセット。client は連続性を仮定しない。 */
  reset: boolean
  events: OverlayEvent[]
}

const MAX_PROVIDER_ID_LEN = 64
const MAX_EVENT_ID_LEN = 128
const MAX_APP_LEN = 48
const MAX_SENDER_LEN = 64
const MAX_TEXT_LEN = 256 // body / text。glass は 576px・プレーンテキストなので十分すぎる上限
const MAX_EVENTS_PER_DOC = 64

const KINDS: ReadonlySet<string> = new Set(['notification', 'toast', 'banner'])

// 既定/上限 (ms)。
export const DEFAULT_EVENT_TTL_MS = 15_000
const MAX_EVENT_TTL_MS = 600_000 // 10min
const MAX_DURATION_MS = 60_000

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.max(min, Math.min(Math.round(v), max))
}

// emit 入力を検証・サニタイズする (server が untrusted な POST body に対して使う)。
// kind ごとに必須フィールドを要求し、欠落・不正は null (= 破棄) にする。
export function parseEmitInput(x: unknown): EmitInput | null {
  if (!x || typeof x !== 'object') return null
  const d = x as Record<string, unknown>
  if (typeof d.providerId !== 'string' || !d.providerId.trim()) return null
  if (typeof d.id !== 'string' || !d.id.trim()) return null
  if (typeof d.kind !== 'string' || !KINDS.has(d.kind)) return null
  const providerId = clip(d.providerId.trim(), MAX_PROVIDER_ID_LEN)
  const id = clip(d.id.trim(), MAX_EVENT_ID_LEN)
  const kind = d.kind as OverlayEventKind
  const out: EmitInput = { providerId, id, kind }

  if (kind === 'notification') {
    const app = typeof d.app === 'string' ? clip(d.app, MAX_APP_LEN) : ''
    const sender = typeof d.sender === 'string' ? clip(d.sender, MAX_SENDER_LEN) : ''
    const body = typeof d.body === 'string' ? clip(d.body, MAX_TEXT_LEN) : ''
    if (!app && !sender && !body) return null // 空通知は破棄
    if (app) out.app = app
    if (sender) out.sender = sender
    if (body) out.body = body
  } else {
    // toast / banner
    if (typeof d.text !== 'string' || !d.text.trim()) return null
    out.text = clip(d.text, MAX_TEXT_LEN)
  }

  const durationMs = clampInt(d.durationMs, 0, MAX_DURATION_MS)
  if (durationMs !== undefined) out.durationMs = durationMs
  const ttlMs = clampInt(d.ttlMs, 0, MAX_EVENT_TTL_MS)
  out.ttlMs = ttlMs ?? DEFAULT_EVENT_TTL_MS
  return out
}

// 配送形 (seq/ts 付き) を検証する。client が server からの EventsDoc.events を通すときに使う。
function parseOverlayEvent(x: unknown): OverlayEvent | null {
  const base = parseEmitInput(x)
  if (!base) return null
  const d = x as Record<string, unknown>
  if (typeof d.seq !== 'number' || !Number.isFinite(d.seq)) return null
  const ts = typeof d.ts === 'number' && Number.isFinite(d.ts) ? d.ts : Date.now()
  return { ...base, seq: d.seq, ts }
}

// GET /api/events のレスポンスを検証・サニタイズする (client が untrusted な server 応答に使う)。
export function parseEventsDoc(x: unknown): EventsDoc | null {
  if (!x || typeof x !== 'object') return null
  const d = x as Record<string, unknown>
  if (typeof d.version !== 'number' || typeof d.cursor !== 'number') return null
  const events: OverlayEvent[] = []
  if (Array.isArray(d.events)) {
    for (const e of d.events) {
      if (events.length >= MAX_EVENTS_PER_DOC) break
      const ev = parseOverlayEvent(e)
      if (ev) events.push(ev)
    }
  }
  return {
    version: d.version,
    sourceId: typeof d.sourceId === 'string' ? clip(d.sourceId, MAX_PROVIDER_ID_LEN) : undefined,
    cursor: d.cursor,
    reset: d.reset === true,
    events,
  }
}
