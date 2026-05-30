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
  urls: string[]
  since: number
  seen: Map<string, number> // key=`<len>:<providerId>:<id>` -> ts (dedupe, 挿入順で古いものから落とす)
}

const loops = new Map<string, Loop>()

const SEEN_MAX = 256
const ERROR_BACKOFF_MS = 5_000
const WAIT_MS = 25_000

function dispatchOverlay(e: OverlayEvent): void {
  if (typeof window === 'undefined') return
  // wire event → glass の 'toolbar:overlay' detail (onOverlayEvent が受ける)。
  const detail =
    e.kind === 'toast'
      ? { kind: 'toast', text: e.text ?? '', durationMs: e.durationMs }
      : e.kind === 'banner'
        ? { kind: 'banner', text: e.text ?? '' }
        : { kind: 'notification', app: e.app ?? '', sender: e.sender ?? '', body: e.body ?? '' }
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
    const doc = await firstReachable(loop.urls, ctl.signal, (u) =>
      fetchEventsFrom(u, loop.since, WAIT_MS, ctl.signal),
    )
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
      dispatchOverlay(e)
    }
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
  // 未登録の source にループを張る。
  for (const s of sources) {
    if (loops.has(s.id) || !s.urls.length) continue
    const loop: Loop = { ctl: new AbortController(), urls: [...s.urls], since: 0, seen: new Map() }
    loops.set(s.id, loop)
    void runLoop(loop)
  }
}

// 全ループを停止する (glass の cleanup から呼ぶ)。
export function stopEvents(): void {
  for (const loop of loops.values()) loop.ctl.abort()
  loops.clear()
}
