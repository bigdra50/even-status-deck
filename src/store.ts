// 共有 runtime store。複数ソース (builtin 算出 + server 並列 fetch) を集約し、
// glass / companion は購読して描画する。取得は 1 系統 (二重ポーリングなし)。
// 失敗ソースは直近成功値を stale 保持。revision + abort で遅延応答を破棄。
import { localStatus } from './builtins'
import {
  type Config,
  enabledSources,
  GEOINFO_SOURCE_ID,
  type OptionValues,
  type SourceDef,
  sourceUrls,
  WEATHER_SOURCE_ID,
} from './config'
import { fetchStatusFromUrls } from './data'
import { geoinfoStatus } from './geoinfo'
import type { StatusDoc } from './status-types'
import { weatherStatus } from './weather'

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
// 失敗時の短期 retry backoff。瞬断は retry で吸収し、全滅 (~70s) で offline 確定。
const RETRY_BACKOFF_MS = [10_000, 20_000, 40_000]
const RETRY_MAX = RETRY_BACKOFF_MS.length

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

// source の鮮度。server のみ判定し builtin は常に online。
// online=直近成功 / stale=失敗中だが retry 継続 (瞬断吸収) / offline=retry 尽きた (切断確定)。
export function getSourceHealth(id: string): 'online' | 'stale' | 'offline' {
  if (defs.find((d) => d.id === id)?.kind === 'builtin') return 'online'
  const n = failCount.get(id) ?? 0
  if (n > RETRY_MAX) return 'offline'
  if (n > 0) return 'stale'
  return statuses.get(id) ? 'online' : 'offline'
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
  if (n < 1 || n > RETRY_MAX) return
  clearRetry(def.id)
  retryTimers.set(
    def.id,
    setTimeout(
      () => {
        retryTimers.delete(def.id)
        void refreshSource(def)
      },
      RETRY_BACKOFF_MS[n - 1],
    ),
  )
}

// active profile の enabledSourceIds に含まれる source だけを fetch 対象にする (builtin 含む)。
// 切替時 (Phase 2) や source 追加/削除のたびに companion/glass から呼ぶ。MVP は Default=全 source。
export function setSourcesFromConfig(cfg: Config): void {
  setSources(enabledSources(cfg))
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
  // 消えたソースは status を捨て、in-flight fetch を abort + revision を進めて遅延応答を無効化する。
  // (mountCompanion の暫定既定ソースのように、bridge 準備前に開始した fetch が後から
  //  statuses[id] を zombie 書き込みし、幽霊ソースとして重複描画されるのを防ぐ。)
  for (const id of [...statuses.keys()]) if (!ids.has(id)) statuses.delete(id)
  const tracked = new Set([...revisions.keys(), ...inflight.keys()])
  for (const id of tracked) {
    if (ids.has(id)) continue
    inflight.get(id)?.abort()
    inflight.delete(id)
    revisions.set(id, (revisions.get(id) ?? 0) + 1) // 進行中 fetch の遅延応答を破棄させる
    sigs.delete(id)
  }
  // 消えた source の鮮度状態 + retry を掃除する。
  for (const id of [...failCount.keys(), ...retryTimers.keys(), ...lastSuccessAt.keys()]) {
    if (ids.has(id)) continue
    clearRetry(id)
    failCount.delete(id)
    lastSuccessAt.delete(id)
  }
  for (const def of defs) {
    const p = prev.get(def.id)
    if (!p || !sameUrlSet(p, def) || p.kind !== def.kind) {
      // 経路集合/種別が変わった source は旧エンドポイントの鮮度を引き継がない (urls 追加でも再試行)。
      // 比較は順序非依存: preferUrl の failover reorder (集合は不変・順序だけ変化) を「経路変更」と
      // 誤検知して鮮度/failover 学習を破棄する回帰を防ぐ (config [A,B] → in-memory [B,A] は同一集合)。
      if (p) {
        clearRetry(def.id)
        failCount.delete(def.id)
        lastSuccessAt.delete(def.id)
      }
      void refreshSource(def)
    }
  }
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

// status の内容シグネチャ (ts 除く)。同一なら notify せず無駄な集約/再描画を起こさない。
function statusSig(d: StatusDoc): string {
  // state も含める: 値据え置きで state だけ変化 (例 ok→stale) しても再描画が要る (PROTOCOL §3)。
  return d.groups
    .map(
      (g) =>
        `${g.id}${g.state ?? ''}:${g.segments.map((s) => `${s.id}=${s.value}|${s.percent ?? ''}|${s.reset ?? ''}|${s.state ?? ''}`).join(',')}`,
    )
    .join(';')
}

// fetch/produce 結果 (StatusDoc|null) の共通後処理。成功は status 更新 + 鮮度リセット + 変化時 notify、
// 失敗は failCount++ + retry。server (URL fetch) と client (producer) の両方から呼ぶ。
function applyResult(def: SourceDef, next: StatusDoc | null): void {
  if (next) {
    const wasUnhealthy = (failCount.get(def.id) ?? 0) > 0
    statuses.set(def.id, next)
    lastSuccessAt.set(def.id, Date.now())
    failCount.set(def.id, 0)
    clearRetry(def.id)
    const sig = statusSig(next)
    const sigChanged = sigs.get(def.id) !== sig
    sigs.set(def.id, sig)
    // 値変化 or offline/stale からの復帰で再描画 (それ以外の同値 poll は churn 抑制で無通知)。
    if (sigChanged || wasUnhealthy) notify()
    return
  }
  // 失敗: 直近成功を stale 保持。retry を重ね、尽きたら offline 確定。
  const n = (failCount.get(def.id) ?? 0) + 1
  failCount.set(def.id, n)
  if (n <= RETRY_MAX) scheduleRetry(def)
  // health 遷移時のみ notify: online->stale (n=1) / stale->offline (n=RETRY_MAX+1)。
  // 中間 retry 失敗 (n=2..RETRY_MAX) は health 不変なので無通知で churn 抑制。
  if (n === 1 || n === RETRY_MAX + 1) notify()
}

// client source の producer (現状 weather のみ)。位置は WebView の geolocation でしか取れないため
// server ではなく client 側で計算する。store は kind==='client' でこれを呼ぶ。
// client source id → producer。**call 時に解決する**のが要点。
// module-init 時に WEATHER_SOURCE_ID を Map/Record のキーに使うと、循環 import の評価順で
// WEATHER_SOURCE_ID が未初期化(undefined)になりキーがズレ、'client.weather' を引けず
// producer=NO になる(weather が一度も動かなかった真因)。関数なら参照は呼び出し時=初期化後。
function clientProducer(
  id: string,
): ((signal: AbortSignal, options?: OptionValues) => Promise<StatusDoc | null>) | undefined {
  if (id === WEATHER_SOURCE_ID) return weatherStatus
  if (id === GEOINFO_SOURCE_ID) return geoinfoStatus
  return undefined
}

async function refreshSource(def: SourceDef): Promise<void> {
  if (def.kind === 'builtin') {
    statuses.set(def.id, localStatus())
    notify()
    return
  }
  // client: producer (geolocation→open-meteo 等) を呼ぶ。server と同じ revision/abort で
  // 遅延応答を破棄し、applyResult で鮮度/notify を共通処理する。producer 内で TTL キャッシュする。
  if (def.kind === 'client') {
    const produce = clientProducer(def.id)
    console.log(`[store] client refresh ${def.id} producer=${produce ? 'yes' : 'NO'}`) // 診断
    if (!produce) return
    const rev = (revisions.get(def.id) ?? 0) + 1
    revisions.set(def.id, rev)
    inflight.get(def.id)?.abort()
    const ctl = new AbortController()
    inflight.set(def.id, ctl)
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
    return
  }
  const urls = sourceUrls(def)
  if (!urls.length) return
  const rev = (revisions.get(def.id) ?? 0) + 1
  revisions.set(def.id, rev)
  inflight.get(def.id)?.abort()
  const ctl = new AbortController()
  inflight.set(def.id, ctl)
  // 複数経路を到達順に試す (先頭優先・失敗で次)。成功した経路を defs の先頭へ寄せ、次 poll で
  // 同経路を優先する (永続化はしない: config の urls 順はユーザー指定を尊重する)。
  const hit = await fetchStatusFromUrls(urls, ctl.signal)
  if (rev !== revisions.get(def.id)) return // 遅延応答は破棄
  if (hit) preferUrl(def.id, hit.url)
  applyResult(def, hit?.status ?? null)
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
