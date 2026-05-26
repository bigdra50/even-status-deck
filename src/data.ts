// データ層 API。URL を明示し timeout / abort 付きで取得する純粋関数 (マルチソース集約用)。
// 可変 base グローバルは廃止 (store が接続先を保持し revision で遅延応答を破棄する)。
import type { StatusDoc } from './status-types'

export type MachineInfo = {
  machineId: string
  label: string
  availableSources: string[]
}

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

export const fetchStatusFrom = (url: string, signal?: AbortSignal) =>
  getJsonFrom<StatusDoc>(url, '/api/status', signal)
export const fetchMachineFrom = (url: string, signal?: AbortSignal) =>
  getJsonFrom<MachineInfo>(url, '/api/machine', signal)
