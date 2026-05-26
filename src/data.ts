// dev server (sideload) のデータ層 API を叩く。store 配布時はベース URL を差し替える。

export type MachineInfo = {
  machineId: string
  label: string
  availableSources: string[]
}

export type Window = { utilization: number; resets_at: string | null }
export type ClaudeLimits = {
  five_hour?: Window | null
  seven_day?: Window | null
  seven_day_sonnet?: Window | null
  seven_day_opus?: Window | null
  error?: string
}

export type CodexWindow = { usedPercent: number; resetsAt: number }
export type CodexLimits = {
  primary?: CodexWindow | null
  secondary?: CodexWindow | null
  planType?: string
  error?: string
}

export type Usage = {
  date?: string
  messages?: number
  estCostUsd?: number
  error?: string
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export const fetchMachine = () => getJson<MachineInfo>('/api/machine')
export const fetchClaudeLimits = () => getJson<ClaudeLimits>('/api/claude-limits')
export const fetchCodexLimits = () => getJson<CodexLimits>('/api/codex-limits')
export const fetchUsage = () => getJson<Usage>('/api/claude-usage')
