// /api/events (long-poll) と POST /api/emit のワイヤ型。サーバーとクライアントで共有する。
// transient overlay イベント (notification / toast / banner) を運ぶ。これは永続状態の
// StatusDoc (status-types.ts) とは別軸: fire-once で、再取得しても再表示しない (client が id で dedupe)。
//
// 方向:
//   provider/watcher → POST /api/emit (loopback) → server buffer → GET /api/events (long-poll) → client
//
// dialog は往復 (onResult) が要るためリモートイベントには含めない (PROTOCOL §10 reserved の /api/action 方向)。

export type OverlayEventKind = 'notification' | 'toast' | 'banner' | 'dialog'

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
  /** dialog: タイトル。 */
  title?: string
  /** dialog: 本文。 */
  message?: string
  /** dialog: 選択肢ラベル (例 ["はい","いいえ"])。結果は index/label で返る。 */
  actions?: string[]
  /** toast: 自動消去までの ms。 */
  durationMs?: number
  /** server buffer の保持・client 配送猶予 (ms)。 */
  ttlMs?: number
  /** dialog のみ: server が払い出す相関 ID (client は応答時に /api/action へ返す)。emit 入力では無視。 */
  requestId?: string
}

// server が seq (source-local 単調増加) と ts を付与した配送形。dialog は requestId 付き。
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
const MAX_TEXT_LEN = 256 // body / text / message。glass は 576px・プレーンテキストなので十分すぎる上限
const MAX_TITLE_LEN = 48 // dialog タイトル (1 行)
const MAX_ACTIONS = 4 // dialog 選択肢数 (リング scroll で選べる範囲)
const MAX_ACTION_LEN = 24 // 選択肢ラベル
const MAX_REQUEST_ID_LEN = 64
const MAX_EVENTS_PER_DOC = 64

const KINDS: ReadonlySet<string> = new Set(['notification', 'toast', 'banner', 'dialog'])

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

// notification kind のフィールドを検証する。app/sender/body が全て空なら破棄 (null)。
function applyNotificationFields(d: Record<string, unknown>, out: EmitInput): boolean {
  const app = typeof d.app === 'string' ? clip(d.app, MAX_APP_LEN) : ''
  const sender = typeof d.sender === 'string' ? clip(d.sender, MAX_SENDER_LEN) : ''
  const body = typeof d.body === 'string' ? clip(d.body, MAX_TEXT_LEN) : ''
  if (!app && !sender && !body) return false // 空通知は破棄
  if (app) out.app = app
  if (sender) out.sender = sender
  if (body) out.body = body
  return true
}

// dialog kind のフィールドを検証する。質問文 (title/message) と選択肢の両方が無ければ破棄 (null)。
function applyDialogFields(d: Record<string, unknown>, out: EmitInput): boolean {
  const title = typeof d.title === 'string' ? clip(d.title, MAX_TITLE_LEN) : ''
  const message = typeof d.message === 'string' ? clip(d.message, MAX_TEXT_LEN) : ''
  const actions = Array.isArray(d.actions)
    ? d.actions
        .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        .slice(0, MAX_ACTIONS)
        .map((a) => clip(a, MAX_ACTION_LEN))
    : []
  if ((!title && !message) || actions.length < 1) return false // 質問文 or 選択肢が無ければ破棄
  if (title) out.title = title
  if (message) out.message = message
  out.actions = actions
  return true
}

// toast / banner kind のフィールドを検証する。text が無ければ破棄 (null)。
function applyTextFields(d: Record<string, unknown>, out: EmitInput): boolean {
  if (typeof d.text !== 'string' || !d.text.trim()) return false
  out.text = clip(d.text, MAX_TEXT_LEN)
  return true
}

// providerId/id/kind の必須ヘッダフィールドを検証・サニタイズする。欠落・不正は null (= 破棄)。
function parseEmitHeader(
  d: Record<string, unknown>,
): Pick<EmitInput, 'providerId' | 'id' | 'kind'> | null {
  if (typeof d.providerId !== 'string' || !d.providerId.trim()) return null
  if (typeof d.id !== 'string' || !d.id.trim()) return null
  if (typeof d.kind !== 'string' || !KINDS.has(d.kind)) return null
  return {
    providerId: clip(d.providerId.trim(), MAX_PROVIDER_ID_LEN),
    id: clip(d.id.trim(), MAX_EVENT_ID_LEN),
    kind: d.kind as OverlayEventKind,
  }
}

// kind ごとの必須フィールド検証を out へ適用する。欠落・不正は false (= 破棄)。
function applyKindFields(d: Record<string, unknown>, out: EmitInput): boolean {
  if (out.kind === 'notification') return applyNotificationFields(d, out)
  if (out.kind === 'dialog') return applyDialogFields(d, out)
  return applyTextFields(d, out) // toast / banner
}

// durationMs / ttlMs (共通の任意フィールド) を out へ適用する。ttlMs は未指定/不正なら既定値。
function applyEmitTiming(d: Record<string, unknown>, out: EmitInput): void {
  const durationMs = clampInt(d.durationMs, 0, MAX_DURATION_MS)
  if (durationMs !== undefined) out.durationMs = durationMs
  const ttlMs = clampInt(d.ttlMs, 0, MAX_EVENT_TTL_MS)
  out.ttlMs = ttlMs ?? DEFAULT_EVENT_TTL_MS
}

// emit 入力を検証・サニタイズする (server が untrusted な POST body に対して使う)。
// kind ごとに必須フィールドを要求し、欠落・不正は null (= 破棄) にする。
export function parseEmitInput(x: unknown): EmitInput | null {
  if (!x || typeof x !== 'object') return null
  const d = x as Record<string, unknown>
  const header = parseEmitHeader(d)
  if (!header) return null
  const out: EmitInput = { ...header }
  if (!applyKindFields(d, out)) return null
  applyEmitTiming(d, out)
  return out
}

// 配送形 (seq/ts 付き) を検証する。client が server からの EventsDoc.events を通すときに使う。
function parseOverlayEvent(x: unknown): OverlayEvent | null {
  const base = parseEmitInput(x)
  if (!base) return null
  const d = x as Record<string, unknown>
  if (typeof d.seq !== 'number' || !Number.isFinite(d.seq)) return null
  const ts = typeof d.ts === 'number' && Number.isFinite(d.ts) ? d.ts : Date.now()
  const out: OverlayEvent = { ...base, seq: d.seq, ts }
  if (typeof d.requestId === 'string' && d.requestId) {
    out.requestId = clip(d.requestId, MAX_REQUEST_ID_LEN)
  }
  // dialog は応答に requestId が要る。無ければ返答不能なので破棄。
  if (out.kind === 'dialog' && !out.requestId) return null
  return out
}

// POST /api/action の入力 (dialog 応答)。client → server(LAN)。server が untrusted 前提で検証する。
export type DialogResultInput = {
  type: 'dialog.result'
  requestId: string
  index: number
  action?: string
}

export function parseDialogResult(x: unknown): DialogResultInput | null {
  if (!x || typeof x !== 'object') return null
  const d = x as Record<string, unknown>
  if (d.type !== 'dialog.result') return null
  if (typeof d.requestId !== 'string' || !d.requestId.trim()) return null
  if (typeof d.index !== 'number' || !Number.isInteger(d.index) || d.index < 0) return null
  const out: DialogResultInput = {
    type: 'dialog.result',
    requestId: clip(d.requestId.trim(), MAX_REQUEST_ID_LEN),
    index: d.index,
  }
  if (typeof d.action === 'string') out.action = clip(d.action, MAX_ACTION_LEN)
  return out
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
