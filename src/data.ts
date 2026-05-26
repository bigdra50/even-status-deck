// データ層 API。マルチソース集約のため URL を明示して取得する純粋 API を提供する。
// (旧: 単一 base グローバル + 相対 fetch。Ph2 で store に集約後に撤去予定)
import type { StatusDoc } from './status-types'

export type MachineInfo = {
  machineId: string
  label: string
  availableSources: string[]
}

// --- 旧 API (単一 base。Ph2 で撤去) -------------------------------------------
let base = ''
export function setDataBase(url: string): void {
  base = url.replace(/\/+$/, '')
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(base + url)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export const fetchMachine = () => getJson<MachineInfo>('/api/machine')
export const fetchStatus = () => getJson<StatusDoc>('/api/status')

// --- 新 API: URL 明示 + timeout/abort (マルチソース集約用) ----------------------
// caller の signal と 8s timeout の両方で abort する。base グローバルに依存しない。
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
