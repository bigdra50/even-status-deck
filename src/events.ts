// client 側 overlay イベント long-poll (PROTOCOL §11)。
// capabilities.events を広告する server source ごとに /api/events を長ポーリングし、
// 新着を (providerId,id) で dedupe して window 'toolbar:overlay' に流す。
// overlay を描くのは glass のみなので、glass のライフサイクルから startEvents/stopEvents する。
//
// jettison/電池対策: events を広告しない source は long-poll しない。waitMs=25s で
// idle churn を抑え、エラー時は backoff。urls が変わらない source はループを張り替えない。
import { fetchEventsFrom, fetchMachineFrom } from './data'
import type { OverlayEvent } from './event-types'

export type EventSource = { id: string; urls: string[] }

type Loop = {
  ctl: AbortController
  id: string // source id (since 永続化のキー)
  urls: string[]
  since: number
  seen: Map<string, number> // key=`<len>:<providerId>:<id>` -> ts (dedupe, 挿入順で古いものから落とす)
  storage: StorageLike | undefined // since 永続化先 (無ければ非永続)
}

const loops = new Map<string, Loop>()

const SEEN_MAX = 256
const ERROR_BACKOFF_MS = 5_000
const WAIT_MS = 25_000

// since (cursor) を reload 跨ぎで永続化する。WKWebView は前面でも数分で reload され、
// その度に since=0 に戻ると直近の overlay を再生してしまう。source 単位で保存/復元する。
const SINCE_KEY_PREFIX = 'status-deck:events:since:'

// localStorage 互換の最小インターフェース (テスト用にモックを差せる)。
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function sinceKey(sourceId: string): string {
  return `${SINCE_KEY_PREFIX}${sourceId}`
}

// 既定の storage (window.localStorage)。無い環境では undefined。
function defaultStorage(): StorageLike | undefined {
  try {
    if (typeof window === 'undefined') return undefined
    return window.localStorage
  } catch {
    return undefined // localStorage アクセスが例外を投げる環境 (privacy mode 等)
  }
}

// 保存済み since を復元する。未保存・不正・例外は 0 (= 従来挙動)。
export function loadSince(storage: StorageLike | undefined, sourceId: string): number {
  if (!storage) return 0
  try {
    const raw = storage.getItem(sinceKey(sourceId))
    if (!raw) return 0
    // localStorage は外部から改竄され得る。saveSince は String(非負整数)=/^\d+$/ しか書かないので、
    // 読み側も部分パース (parseInt の "42abc"→42 等) を許さず、純粋な非負整数のみ採用する。
    // 桁あふれ ("9".repeat(20) 等) は isSafeInteger で弾く。不正は 0 (= 従来挙動)。
    const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    return Number.isSafeInteger(n) && n >= 0 ? n : 0
  } catch {
    return 0 // getItem が例外を投げる場合は no-op
  }
}

// since を保存する。storage 無し・quota 例外等は no-op (従来通り)。
export function saveSince(storage: StorageLike | undefined, sourceId: string, since: number): void {
  if (!storage || !Number.isInteger(since) || since < 0) return
  try {
    storage.setItem(sinceKey(sourceId), String(since))
  } catch {
    // quota 超過等は無視 (永続化は best-effort)
  }
}

// wire event → glass の 'toolbar:overlay' detail (onOverlayEvent が受ける)。
// dialog は応答を返す先 (replyUrl) と requestId を載せる。
function dispatchOverlay(e: OverlayEvent, replyUrl: string): void {
  if (typeof window === 'undefined') return
  let detail: unknown
  if (e.kind === 'toast') detail = { kind: 'toast', text: e.text ?? '', durationMs: e.durationMs }
  else if (e.kind === 'banner') detail = { kind: 'banner', text: e.text ?? '' }
  else if (e.kind === 'dialog') {
    detail = {
      kind: 'dialog',
      title: e.title ?? '',
      message: e.message ?? '',
      actions: e.actions ?? [],
      requestId: e.requestId ?? '',
      replyUrl,
    }
  } else {
    detail = { kind: 'notification', app: e.app ?? '', sender: e.sender ?? '', body: e.body ?? '' }
  }
  window.dispatchEvent(new CustomEvent('toolbar:overlay', { detail }))
}

function remember(seen: Map<string, number>, k: string, ts: number): void {
  seen.set(k, ts)
  if (seen.size > SEEN_MAX) {
    let drop = seen.size - SEEN_MAX
    for (const key of seen.keys()) {
      if (drop-- <= 0) break
      seen.delete(key)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}

// urls を到達順に試して machine / events を 1 つ取る (先頭優先)。
async function firstReachable<T>(
  urls: string[],
  signal: AbortSignal,
  get: (url: string) => Promise<T | null>,
): Promise<T | null> {
  for (const u of urls) {
    if (signal.aborted) return null
    const r = await get(u)
    if (r) return r
  }
  return null
}

async function runLoop(loop: Loop): Promise<void> {
  const { ctl } = loop
  // capability gate: events を広告しない source は long-poll しない (無駄な負荷を避ける)。
  const machine = await firstReachable(loop.urls, ctl.signal, (u) =>
    fetchMachineFrom(u, ctl.signal),
  )
  if (ctl.signal.aborted) return
  if (!machine?.capabilities?.events) return

  while (!ctl.signal.aborted) {
    // 到達した url を replyUrl として捕捉する (dialog 応答の POST 先に使う)。
    let doc = null
    let replyUrl = loop.urls[0] ?? ''
    for (const u of loop.urls) {
      if (ctl.signal.aborted) return
      const d = await fetchEventsFrom(u, loop.since, WAIT_MS, ctl.signal)
      if (d) {
        doc = d
        replyUrl = u
        break
      }
    }
    if (ctl.signal.aborted) return
    if (!doc) {
      await sleep(ERROR_BACKOFF_MS, ctl.signal) // 全経路失敗 → backoff して再試行
      continue
    }
    if (doc.reset) loop.seen.clear() // 連続性を捨てて cursor を採用
    for (const e of doc.events) {
      const k = `${e.providerId.length}:${e.providerId}:${e.id}`
      if (loop.seen.has(k)) continue
      remember(loop.seen, k, e.ts)
      dispatchOverlay(e, replyUrl)
    }
    // cursor が進んだら reload 跨ぎ用に保存する (再開時の重複表示を防ぐ)。
    if (doc.cursor > loop.since) saveSince(loop.storage, loop.id, doc.cursor)
    loop.since = doc.cursor
  }
}

function sameUrls(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((u, i) => u === b[i])
}

// 指定 source 群に対し long-poll を張る。既存ループのうち消えた source は停止し、
// urls が変わった source は張り替え、未変更はそのまま (since/seen を維持)。
export function startEvents(sources: EventSource[]): void {
  const next = new Map(sources.map((s) => [s.id, s]))
  // 消えた / urls 変更の source を停止。
  for (const [id, loop] of [...loops]) {
    const src = next.get(id)
    if (!src || !sameUrls(loop.urls, src.urls)) {
      loop.ctl.abort()
      loops.delete(id)
    }
  }
  // 未登録の source にループを張る。since は reload 跨ぎの保存値から復元する。
  const storage = defaultStorage()
  for (const s of sources) {
    if (loops.has(s.id) || !s.urls.length) continue
    const loop: Loop = {
      ctl: new AbortController(),
      id: s.id,
      urls: [...s.urls],
      since: loadSince(storage, s.id),
      seen: new Map(),
      storage,
    }
    loops.set(s.id, loop)
    void runLoop(loop)
  }
}

// 全ループを停止する (glass の cleanup から呼ぶ)。
export function stopEvents(): void {
  for (const loop of loops.values()) loop.ctl.abort()
  loops.clear()
}
