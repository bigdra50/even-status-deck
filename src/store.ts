// 共有 runtime store。複数ソース (builtin 算出 + server 並列 fetch) を集約し、
// glass / companion は購読して描画する。取得は 1 系統 (二重ポーリングなし)。
// 失敗ソースは直近成功値を stale 保持。revision + abort で遅延応答を破棄。

import { localStatus } from './builtins'
import {
  type Config,
  enabledSources,
  LOCATION_SOURCE_ID,
  type OptionValues,
  type SourceDef,
  sourceUrls,
} from './config'
import { fetchStatusFromUrls } from './data'
import { bumpDiag } from './diag-counters'
import { recordStatusHistory } from './history'
import { locationStatus } from './location'
import type { StatusDoc } from './status-types'
import {
  healthFromFailCount,
  RETRY_MAX,
  retryDelayMs,
  shouldNotifyOnFailure,
  shouldNotifyOnSuccess,
  statusSig,
} from './store-health'

type Listener = () => void

let defs: SourceDef[] = []
const statuses = new Map<string, StatusDoc | null>() // sourceId -> 直近成功 status (stale 保持)
const revisions = new Map<string, number>()
const inflight = new Map<string, AbortController>()
const listeners = new Set<Listener>()
let pollTimer: ReturnType<typeof setInterval> | null = null
const sigs = new Map<string, string>() // sourceId -> 直近 status の内容シグネチャ (無変化 poll の notify 抑制)
const lastSuccessAt = new Map<string, number>() // sourceId -> 直近成功時刻 (Last seen 表示 + 鮮度)
const failCount = new Map<string, number>() // sourceId -> 連続失敗回数 (0=健全 / 1..RETRY_MAX=stale / >RETRY_MAX=offline)
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>() // 失敗時の短期 retry

function notify(): void {
  bumpDiag('notify') // #4 定常状態計測: notify 頻度を実機で確認するための診断カウンタ
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

// source の鮮度。server のみ判定し builtin は常に online。
// online=直近成功 / stale=失敗中だが retry 継続 (瞬断吸収) / offline=retry 尽きた (切断確定)。
export function getSourceHealth(id: string): 'online' | 'stale' | 'offline' {
  if (defs.find((d) => d.id === id)?.kind === 'builtin') return 'online'
  const n = failCount.get(id) ?? 0
  return healthFromFailCount(n, statuses.get(id) != null)
}

// 直近成功時刻 (companion の "Last seen Xm ago" 表示用)。未成功は null。
export function getLastSuccessAt(id: string): number | null {
  return lastSuccessAt.get(id) ?? null
}

// 現在オンラインな server source の id 集合 (Phase 4: プリセット提案の入力)。
// builtin は常に online だが状況識別の材料にならないため除外し、server だけを返す。
export function getOnlineServerIds(): Set<string> {
  const out = new Set<string>()
  for (const d of defs) {
    if (d.kind === 'server' && getSourceHealth(d.id) === 'online') out.add(d.id)
  }
  return out
}

// 描画用 status: offline の server source は除外 (null) し、glass/preview に古い値=嘘を出さない。
// online/stale は保持値をそのまま返す (stale は瞬断中の表示維持)。
export function getRenderableStatuses(): Record<string, StatusDoc | null> {
  const out: Record<string, StatusDoc | null> = {}
  for (const [id, s] of statuses) out[id] = getSourceHealth(id) === 'offline' ? null : s
  return out
}

function clearRetry(id: string): void {
  const t = retryTimers.get(id)
  if (t) {
    clearTimeout(t)
    retryTimers.delete(id)
  }
}

// 失敗回数に応じた backoff で retry を 1 回仕込む (stale 窓 1..RETRY_MAX の間のみ)。
function scheduleRetry(def: SourceDef): void {
  const n = failCount.get(def.id) ?? 0
  const delay = retryDelayMs(n)
  if (delay === undefined) return
  clearRetry(def.id)
  retryTimers.set(
    def.id,
    setTimeout(() => {
      retryTimers.delete(def.id)
      void refreshSource(def)
    }, delay),
  )
}

// active profile の enabledSourceIds に含まれる source だけを fetch 対象にする (builtin 含む)。
// 切替時 (Phase 2) や source 追加/削除のたびに companion/glass から呼ぶ。MVP は Default=全 source。
export function setSourcesFromConfig(cfg: Config): void {
  setSources(enabledSources(cfg))
}

// 消えたソースの status / in-flight fetch / revision / sig を掃除する。
// (mountCompanion の暫定既定ソースのように、bridge 準備前に開始した fetch が後から
//  statuses[id] を zombie 書き込みし、幽霊ソースとして重複描画されるのを防ぐ。)
function cleanupRemovedStatuses(ids: Set<string>): void {
  for (const id of [...statuses.keys()]) if (!ids.has(id)) statuses.delete(id)
  const tracked = new Set([...revisions.keys(), ...inflight.keys()])
  for (const id of tracked) {
    if (ids.has(id)) continue
    inflight.get(id)?.abort()
    inflight.delete(id)
    revisions.set(id, (revisions.get(id) ?? 0) + 1) // 進行中 fetch の遅延応答を破棄させる
    sigs.delete(id)
  }
}

// 消えたソースの鮮度状態 (failCount/retryTimer/lastSuccessAt) を掃除する。
function cleanupRemovedHealth(ids: Set<string>): void {
  for (const id of [...failCount.keys(), ...retryTimers.keys(), ...lastSuccessAt.keys()]) {
    if (ids.has(id)) continue
    clearRetry(id)
    failCount.delete(id)
    lastSuccessAt.delete(id)
  }
}

// prev と比較し、経路集合/種別が変わった (= 新規含む) source だけ鮮度を捨てて再取得する。
// 比較は順序非依存: preferUrl の failover reorder (集合は不変・順序だけ変化) を「経路変更」と
// 誤検知して鮮度/failover 学習を破棄する回帰を防ぐ (config [A,B] → in-memory [B,A] は同一集合)。
function refreshIfChanged(def: SourceDef, prev: Map<string, SourceDef>): void {
  const p = prev.get(def.id)
  if (p && sameUrlSet(p, def) && p.kind === def.kind) return
  // 経路集合/種別が変わった source は旧エンドポイントの鮮度を引き継がない (urls 追加でも再試行)。
  if (p) {
    clearRetry(def.id)
    failCount.delete(def.id)
    lastSuccessAt.delete(def.id)
  }
  void refreshSource(def)
}

// ソース一覧を設定する (enabledSources で絞った list を受け取る)。
// 変更/新規ソースだけ取得し、未変更は再 fetch しない (無駄な abort/取得を防ぐ)。消えたソースは掃除。
export function setSources(next: SourceDef[]): void {
  const prev = new Map(defs.map((d) => [d.id, d]))
  // config.sources と同一参照にすると後続の push/mutation で diff が壊れるためクローンする。
  defs = next.map((d) => ({ ...d }))
  // 診断: 有効ソースの id:kind を出す (weather が client として登録されているか確認用)。
  console.log('[store] sources:', defs.map((d) => `${d.id}:${d.kind}`).join(', ') || '(none)')
  const ids = new Set(defs.map((d) => d.id))
  cleanupRemovedStatuses(ids)
  cleanupRemovedHealth(ids)
  for (const def of defs) refreshIfChanged(def, prev)
}

// 2 source の経路集合が同一か (順序・重複を無視)。setSources の diff 判定に使う。
// preferUrl は failover で urls の順序だけを変える (集合は不変) ため、順序依存比較だと
// reorder を「経路変更」と誤検知して鮮度/failover 学習を破棄してしまう。集合で比較する。
function sameUrlSet(a: SourceDef, b: SourceDef): boolean {
  const x = [...new Set(sourceUrls(a))].sort()
  const y = [...new Set(sourceUrls(b))].sort()
  return x.length === y.length && x.every((u, i) => u === y[i])
}

// 成功した経路を defs (クローン) の urls 先頭へ寄せる。次 poll で同経路を最初に試すための
// in-memory ヒント (config の永続 urls 順は変えない = ユーザー指定の到達順を尊重する)。
function preferUrl(id: string, url: string): void {
  const def = defs.find((d) => d.id === id)
  if (!def?.urls?.length || def.urls[0] === url) return
  const idx = def.urls.indexOf(url)
  if (idx <= 0) return
  def.urls = [url, ...def.urls.slice(0, idx), ...def.urls.slice(idx + 1)]
}

// fetch/produce 結果 (StatusDoc|null) の共通後処理。成功は status 更新 + 鮮度リセット + 変化時 notify、
// 失敗は failCount++ + retry。server (URL fetch) と client (producer) の両方から呼ぶ。
function applyResult(def: SourceDef, next: StatusDoc | null): void {
  if (next) {
    const wasUnhealthy = (failCount.get(def.id) ?? 0) > 0
    statuses.set(def.id, next)
    recordStatusHistory(def.id, next, Date.now()) // sparkline image cell の数値履歴 (メモリ内)
    lastSuccessAt.set(def.id, Date.now())
    failCount.set(def.id, 0)
    clearRetry(def.id)
    const sig = statusSig(next)
    const sigChanged = sigs.get(def.id) !== sig
    sigs.set(def.id, sig)
    // 値変化 or offline/stale からの復帰で再描画 (それ以外の同値 poll は churn 抑制で無通知)。
    if (shouldNotifyOnSuccess(sigChanged, wasUnhealthy)) notify()
    return
  }
  // 失敗: 直近成功を stale 保持。retry を重ね、尽きたら offline 確定。
  const n = (failCount.get(def.id) ?? 0) + 1
  failCount.set(def.id, n)
  if (n <= RETRY_MAX) scheduleRetry(def)
  // health 遷移時のみ notify: online->stale (n=1) / stale->offline (n=RETRY_MAX+1)。
  // 中間 retry 失敗 (n=2..RETRY_MAX) は health 不変なので無通知で churn 抑制。
  if (shouldNotifyOnFailure(n)) notify()
}

// client source の producer。位置は WebView の geolocation でしか取れないため server ではなく client
// 側で計算する。store は kind==='client' でこれを呼ぶ。統合 source "Location" の 1 本のみ
// (locationStatus が内部で weather/air/geocode/geoinfo/places を呼び 2 group に再編する)。
// **call 時に解決する**のが要点(module-init で LOCATION_SOURCE_ID をキーにすると循環 import の
// 評価順で undefined になりキーがズレる。関数なら参照は呼び出し時=初期化後)。
function clientProducer(
  id: string,
): ((signal: AbortSignal, options?: OptionValues) => Promise<StatusDoc | null>) | undefined {
  if (id === LOCATION_SOURCE_ID) return locationStatus
  return undefined
}

// 新 revision を払い出し、in-flight fetch を abort して新 controller を登録する。
// server/client 両経路で revision/abort の作法を揃える共通前処理。
function beginFetch(id: string): { rev: number; ctl: AbortController } {
  const rev = (revisions.get(id) ?? 0) + 1
  revisions.set(id, rev)
  inflight.get(id)?.abort()
  const ctl = new AbortController()
  inflight.set(id, ctl)
  return { rev, ctl }
}

// client: producer (geolocation→open-meteo 等) を呼ぶ。server と同じ revision/abort で
// 遅延応答を破棄し、applyResult で鮮度/notify を共通処理する。producer 内で TTL キャッシュする。
async function refreshClientSource(def: SourceDef): Promise<void> {
  const produce = clientProducer(def.id)
  console.log(`[store] client refresh ${def.id} producer=${produce ? 'yes' : 'NO'}`) // 診断
  if (!produce) return
  const { rev, ctl } = beginFetch(def.id)
  let next: StatusDoc | null = null
  try {
    // client source の表示オプション(weather の単位/フォーマット等)を producer へ渡す。
    // 単位変更時は producer 側の optSig が変わり TTL cache を跨いで即再取得する。
    next = await produce(ctl.signal, def.options)
  } catch {
    next = null
  }
  if (rev !== revisions.get(def.id)) return // 遅延応答は破棄
  applyResult(def, next)
}

// server: 複数経路を到達順に試す (先頭優先・失敗で次)。成功した経路を defs の先頭へ寄せ、次 poll で
// 同経路を優先する (永続化はしない: config の urls 順はユーザー指定を尊重する)。
async function refreshServerSource(def: SourceDef): Promise<void> {
  const urls = sourceUrls(def)
  if (!urls.length) return
  const { rev, ctl } = beginFetch(def.id)
  const hit = await fetchStatusFromUrls(urls, ctl.signal)
  if (rev !== revisions.get(def.id)) return // 遅延応答は破棄
  if (hit) preferUrl(def.id, hit.url)
  applyResult(def, hit?.status ?? null)
}

async function refreshSource(def: SourceDef): Promise<void> {
  if (def.kind === 'builtin') {
    const doc = localStatus()
    statuses.set(def.id, doc)
    recordStatusHistory(def.id, doc, Date.now()) // builtin (g2 電池等) も sparkline の履歴対象
    notify()
    return
  }
  if (def.kind === 'client') return refreshClientSource(def)
  return refreshServerSource(def)
}

export async function refreshAll(): Promise<void> {
  await Promise.allSettled(defs.map(refreshSource))
}

// 単一 source を id で再取得する (#36)。表示オプション変更で urls 不変でも再 fetch したいとき companion が呼ぶ。
// 未知 id は無視。client producer 側の TTL キャッシュは別途無効化が要る (単位変更の即時反映は後続 issue)。
export function refreshSourceById(id: string): void {
  const def = defs.find((d) => d.id === id)
  if (def) void refreshSource(def)
}

// builtin (時刻/電池) のみ再計算する (clock tick / 電池更新時)。
export function refreshBuiltins(): void {
  let changed = false
  for (const def of defs) {
    if (def.kind === 'builtin') {
      const doc = localStatus()
      statuses.set(def.id, doc)
      recordStatusHistory(def.id, doc, Date.now()) // 電池 notify 経由の更新も履歴へ
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
