// データ層 API。URL を明示し timeout / abort 付きで取得する純粋関数 (マルチソース集約用)。
// 可変 base グローバルは廃止 (store が接続先を保持し revision で遅延応答を破棄する)。
import { type EventsDoc, parseEventsDoc } from './event-types'
import { parseStatusDoc, type StatusDoc } from './status-types'

// machineId は同一マシン判定 (id 安定化・合流) のキーなので非空 string であることを保証する。
// status と違い軽量だが、空/未設定の machineId を素通しすると別マシン同士が 1 source に
// 潰れる誤合流を招くため (config.reconcileSourceMachine)、受信時に必ず検証する。
export type MachineInfo = {
  machineId: string
  label: string
  availableSources: string[]
  /** 機能発見 (PROTOCOL §10)。events=true なら /api/events long-poll を話せる。 */
  capabilities?: { events?: boolean }
}

const MAX_MACHINE_ID_LEN = 128
const MAX_MACHINE_LABEL_LEN = 48
const MAX_AVAILABLE_SOURCES = 64

// caller の signal と 8s timeout の両方で abort する。
const FETCH_TIMEOUT_MS = 8000
async function getJsonFrom<T>(url: string, path: string, signal?: AbortSignal): Promise<T | null> {
  const clean = url.replace(/\/+$/, '')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', () => ctl.abort(), { once: true })
  }
  try {
    const res = await fetch(clean + path, { signal: ctl.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// 受信 JSON を検証して MachineInfo を返す。machineId が非空 string でないものは null
// (= 接続成功だが machineId 不明) とし、合流/id 安定化のキーに使えるものだけ通す。
// label / availableSources は欠落しても致命的でないので安全な既定へフォールバックする。
export function parseMachineInfo(x: unknown): MachineInfo | null {
  if (!x || typeof x !== 'object') return null
  const d = x as Record<string, unknown>
  if (typeof d.machineId !== 'string') return null
  const machineId = d.machineId.trim()
  if (!machineId || machineId.length > MAX_MACHINE_ID_LEN) return null
  const label =
    typeof d.label === 'string' && d.label ? d.label.slice(0, MAX_MACHINE_LABEL_LEN) : machineId
  const availableSources = Array.isArray(d.availableSources)
    ? d.availableSources
        .filter((s): s is string => typeof s === 'string')
        .slice(0, MAX_AVAILABLE_SOURCES)
    : []
  const out: MachineInfo = { machineId, label, availableSources }
  const caps = d.capabilities
  if (caps && typeof caps === 'object' && (caps as { events?: unknown }).events === true) {
    out.capabilities = { events: true }
  }
  return out
}

// status は受信時に検証・サニタイズする (不正データで描画を壊さない)。
export const fetchStatusFrom = async (
  url: string,
  signal?: AbortSignal,
): Promise<StatusDoc | null> =>
  parseStatusDoc(await getJsonFrom<unknown>(url, '/api/status', signal))
// machine も同様にサニタイズする (machineId が空/未設定なら null = 接続成功でも machineId 不明)。
export const fetchMachineFrom = async (
  url: string,
  signal?: AbortSignal,
): Promise<MachineInfo | null> =>
  parseMachineInfo(await getJsonFrom<unknown>(url, '/api/machine', signal))

// overlay イベントの long-poll (PROTOCOL §11)。timeout は waitMs + 通常 margin。
// pending か reset があれば server が即返し、無ければ waitMs まで保留して空で返る。
// 解析失敗 / HTTP エラー / abort は null (= caller が backoff して再試行)。
export const fetchEventsFrom = async (
  url: string,
  since: number,
  waitMs: number,
  signal?: AbortSignal,
): Promise<EventsDoc | null> => {
  const clean = url.replace(/\/+$/, '')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), waitMs + FETCH_TIMEOUT_MS)
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', () => ctl.abort(), { once: true })
  }
  try {
    const res = await fetch(`${clean}/api/events?since=${since}&waitMs=${waitMs}`, {
      signal: ctl.signal,
    })
    if (!res.ok) return null
    return parseEventsDoc(await res.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// 同一マシンの複数経路 (LAN / VPN 等) を到達順に試す (先頭優先、失敗で次へ)。
// 成功した経路の status とその url を返す。全滅なら null。abort されたら即中断する。
export type StatusHit = { status: StatusDoc; url: string }
export const fetchStatusFromUrls = async (
  urls: string[],
  signal?: AbortSignal,
): Promise<StatusHit | null> => {
  for (const url of urls) {
    if (signal?.aborted) return null
    const status = await fetchStatusFrom(url, signal)
    if (status) return { status, url }
  }
  return null
}
