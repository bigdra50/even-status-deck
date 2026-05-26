// dev server (sideload) のデータ層 API を叩く。store 配布時はベース URL を差し替える。
import type { StatusDoc } from './status-types'

export type MachineInfo = {
  machineId: string
  label: string
  availableSources: string[]
}

// データ取得のベース URL。既定は同一オリジン (相対)。接続テスト成功時に切り替える。
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
// モジュラー segment コア: 表示要素はすべて /api/status (provider 集約) から取得する。
export const fetchStatus = () => getJson<StatusDoc>('/api/status')
