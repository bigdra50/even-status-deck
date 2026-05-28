// 共有 runtime store。複数ソース (builtin 算出 + server 並列 fetch) を集約し、
// glass / companion は購読して描画する。取得は 1 系統 (二重ポーリングなし)。
// 失敗ソースは直近成功値を stale 保持。revision + abort で遅延応答を破棄。
import { localStatus } from './builtins'
import type { SourceDef } from './config'
import { fetchStatusFrom } from './data'
import type { StatusDoc } from './status-types'

type Listener = () => void

let defs: SourceDef[] = []
const statuses = new Map<string, StatusDoc | null>() // sourceId -> 直近成功 status (stale 保持)
const revisions = new Map<string, number>()
const inflight = new Map<string, AbortController>()
const listeners = new Set<Listener>()
let pollTimer: ReturnType<typeof setInterval> | null = null
const sigs = new Map<string, string>() // sourceId -> 直近 status の内容シグネチャ (無変化 poll の notify 抑制)

function notify(): void {
  for (const l of listeners) l()
}

// 外部 (visibility runtime の窓終了タイマー等) から全 subscriber 再描画を促す公開トリガ。
export function pokeListeners(): void {
  notify()
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getSourceStatus(id: string): StatusDoc | null {
  return statuses.get(id) ?? null
}

export function getAllStatuses(): Record<string, StatusDoc | null> {
  const out: Record<string, StatusDoc | null> = {}
  for (const [id, s] of statuses) out[id] = s
  return out
}

// ソース一覧を設定する (companion が config から渡す)。
// 変更/新規ソースだけ取得し、未変更は再 fetch しない (無駄な abort/取得を防ぐ)。消えたソースは掃除。
export function setSources(next: SourceDef[]): void {
  const prev = new Map(defs.map((d) => [d.id, d]))
  // config.sources と同一参照にすると後続の push/mutation で diff が壊れるためクローンする。
  defs = next.map((d) => ({ ...d }))
  const ids = new Set(defs.map((d) => d.id))
  for (const id of [...statuses.keys()]) if (!ids.has(id)) statuses.delete(id)
  for (const def of defs) {
    const p = prev.get(def.id)
    if (!p || p.url !== def.url || p.kind !== def.kind) void refreshSource(def)
  }
}

// status の内容シグネチャ (ts 除く)。同一なら notify せず無駄な集約/再描画を起こさない。
function statusSig(d: StatusDoc): string {
  return d.groups
    .map(
      (g) =>
        `${g.id}:${g.segments.map((s) => `${s.id}=${s.value}|${s.percent ?? ''}|${s.reset ?? ''}`).join(',')}`,
    )
    .join(';')
}

async function refreshSource(def: SourceDef): Promise<void> {
  if (def.kind === 'builtin') {
    statuses.set(def.id, localStatus())
    notify()
    return
  }
  if (!def.url) return
  const rev = (revisions.get(def.id) ?? 0) + 1
  revisions.set(def.id, rev)
  inflight.get(def.id)?.abort()
  const ctl = new AbortController()
  inflight.set(def.id, ctl)
  const next = await fetchStatusFrom(def.url, ctl.signal)
  if (rev !== revisions.get(def.id)) return // 遅延応答は破棄
  if (next) {
    statuses.set(def.id, next) // 失敗 (null) 時は直近成功を stale 保持
    const sig = statusSig(next)
    if (sigs.get(def.id) === sig) return // 内容同一: 値は更新したが notify しない (毎 poll の集約 churn 抑制)
    sigs.set(def.id, sig)
    notify()
  }
}

export async function refreshAll(): Promise<void> {
  await Promise.allSettled(defs.map(refreshSource))
}

// builtin (時刻/電池) のみ再計算する (clock tick / 電池更新時)。
export function refreshBuiltins(): void {
  let changed = false
  for (const def of defs) {
    if (def.kind === 'builtin') {
      statuses.set(def.id, localStatus())
      changed = true
    }
  }
  if (changed) notify()
}

// server を 60s ポーリング。
export function startPolling(intervalMs = 60_000): void {
  if (pollTimer) return
  pollTimer = setInterval(() => void refreshAll(), intervalMs)
}

// 時刻 (毎分 tick) は glass が glass-local タイマーで所有する (store.notify を介した
// 毎分の重い集約が iOS WKWebView の WebContent jettison を招くため。issue #4)。
// refreshBuiltins は電池変化 (onDeviceStatusChanged, 低頻度) からのみ呼ばれる。

export function stop(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
