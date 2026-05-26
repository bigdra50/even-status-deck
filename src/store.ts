// 共有 runtime store。取得 (fetch + ポーリング) を 1 系統に集約し、glass / companion は
// 購読して描画する (旧: 各々が独立ポーリングしていた二重取得を解消)。
// Ph2 時点では単一 url。Ph6 で複数ソースへ拡張する。
import { fetchStatusFrom } from './data'
import type { StatusDoc } from './status-types'

type Listener = () => void

let url: string | null = null
let status: StatusDoc | null = null // 直近成功の status (失敗時は保持し stale 表示)
let revision = 0 // 遅延応答の上書き防止
let inflight: AbortController | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of listeners) l()
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getStatus(): StatusDoc | null {
  return status
}

export function getSourceUrl(): string | null {
  return url
}

// 接続先を切り替える。別ソースの値を見せないよう status を一旦クリアして再取得する。
export function setSourceUrl(next: string | null): void {
  if (next === url) return
  url = next
  status = null
  notify()
  void refresh()
}

export async function refresh(): Promise<void> {
  if (!url) return
  const rev = ++revision
  inflight?.abort()
  const ctl = new AbortController()
  inflight = ctl
  const next = await fetchStatusFrom(url, ctl.signal)
  if (rev !== revision) return // 遅延応答は破棄 (URL 変更後の古い結果で上書きしない)
  if (next) {
    status = next // 失敗 (null) 時は直近成功を保持
    notify()
  }
}

export function startPolling(intervalMs = 60_000): void {
  if (pollTimer) return
  pollTimer = setInterval(() => void refresh(), intervalMs)
}

export function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
