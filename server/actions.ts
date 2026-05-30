// dialog 往復の相関ストア (PROTOCOL §10/§11)。
//
// フロー: emit kind:'dialog' で createDialogRequest() が requestId を払い出し、events で配送 →
// client が選択を POST /api/action → completeDialogRequest() → 質問した watcher は loopback の
// GET /api/action-result?requestId= を pollDialogResult() で long-poll して結果を受け取る。
//
// requestId は unguessable な capability token (server 生成)。結果は accept-once。TTL = 表示有効期限
// 兼 受理期限。LAN から POST /api/action が叩けるので、正当性は「requestId を知っていること」+
// index/action の検証 + 単一受理で守る (confirmation は UX 安全弁であって認証ではない / PROTOCOL §10)。
import { randomBytes } from 'node:crypto'

export type DialogStatus = 'pending' | 'completed' | 'dismissed' | 'expired'
export type DialogResult = { index: number; action: string; ts: number }

type Pending = {
  requestId: string
  providerId: string
  actions: string[]
  createdAt: number
  expiresAt: number
  status: DialogStatus
  result?: DialogResult
}

const requests = new Map<string, Pending>()
const waiters = new Map<string, Set<() => void>>() // requestId -> 結果待ち resolve 群

const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 300_000
const KEEP_AFTER_DONE_MS = 60_000 // completed/expired を保持してから GC

function newRequestId(): string {
  return `act_${randomBytes(12).toString('hex')}`
}

function wake(requestId: string): void {
  const set = waiters.get(requestId)
  if (!set) return
  for (const w of [...set]) w()
  waiters.delete(requestId)
}

// 期限切れ pending を expired にし、done から一定経過したものを削除する。
function gc(now: number): void {
  for (const [id, r] of requests) {
    if (r.status === 'pending') {
      if (now >= r.expiresAt) {
        r.status = 'expired'
        wake(id)
      }
      continue
    }
    const doneAt = r.result?.ts ?? r.expiresAt
    if (now - doneAt >= KEEP_AFTER_DONE_MS) requests.delete(id)
  }
}

// dialog 要求を登録し requestId を払い出す。
export function createDialogRequest(providerId: string, actions: string[], ttlMs?: number): string {
  const now = Date.now()
  gc(now)
  const id = newRequestId()
  const ttl = Math.max(1_000, Math.min(ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS))
  requests.set(id, {
    requestId: id,
    providerId,
    actions,
    createdAt: now,
    expiresAt: now + ttl,
    status: 'pending',
  })
  return id
}

export type CompleteResult =
  | { ok: true }
  | {
      ok: false
      reason: 'not_found' | 'expired' | 'already_completed' | 'bad_index' | 'action_mismatch'
    }

// client の選択を確定する。最初の有効な回答だけ受理する。
export function completeDialogRequest(
  requestId: string,
  index: number,
  action?: string,
): CompleteResult {
  const now = Date.now()
  gc(now)
  const r = requests.get(requestId)
  if (!r) return { ok: false, reason: 'not_found' }
  if (r.status === 'expired' || now >= r.expiresAt) {
    r.status = 'expired'
    wake(requestId)
    return { ok: false, reason: 'expired' }
  }
  if (r.status !== 'pending') return { ok: false, reason: 'already_completed' }
  if (index < 0 || index >= r.actions.length) return { ok: false, reason: 'bad_index' }
  // action(ラベル) を併送してきた場合は index と一致するか検証する (取り違え/競合の検出)。
  if (action !== undefined && action !== r.actions[index]) return { ok: false, reason: 'action_mismatch' }
  r.status = 'completed'
  r.result = { index, action: r.actions[index] ?? '', ts: now }
  wake(requestId)
  return { ok: true }
}

export type DialogPollResult = { status: DialogStatus; result?: DialogResult }

// 質問側 (watcher) 用の long-poll。pending なら waitMs か期限まで待ち、状態を返す。
// requestId が不明 (GC 済 / 偽) なら null。
export async function pollDialogResult(
  requestId: string,
  waitMs: number,
): Promise<DialogPollResult | null> {
  gc(Date.now())
  const r = requests.get(requestId)
  if (!r) return null
  if (r.status !== 'pending') return { status: r.status, result: r.result }

  await new Promise<void>((resolve) => {
    let done = false
    const wakeUp = (): void => {
      if (done) return
      done = true
      clearTimeout(t1)
      clearTimeout(t2)
      const s = waiters.get(requestId)
      s?.delete(wakeUp)
      if (s && !s.size) waiters.delete(requestId)
      resolve()
    }
    const set = waiters.get(requestId) ?? new Set<() => void>()
    set.add(wakeUp)
    waiters.set(requestId, set)
    const t1 = setTimeout(wakeUp, Math.max(0, waitMs))
    const t2 = setTimeout(wakeUp, Math.max(0, r.expiresAt - Date.now())) // 期限で起こす
  })

  gc(Date.now())
  const r2 = requests.get(requestId)
  if (!r2) return { status: 'expired' }
  return { status: r2.status, result: r2.result }
}

export function _resetForTest(): void {
  requests.clear()
  waiters.clear()
}
