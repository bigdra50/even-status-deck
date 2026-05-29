// machine info provider。hostname から machineId を導出し、claude / codex の有無を
// `<cmd> --version` の成否で検出する (vite.config.ts:19-42 の移植)。
// hasCli はクロスプラットフォーム化: Windows では `<cmd>.cmd` も試す。
import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

// machineInfo は dev/standalone とも高頻度 poll されるため 60s TTL でキャッシュする。
let machineCache: { data: MachineInfo; at: number } | null = null
const MACHINE_TTL_MS = 60_000

// /api/machine のレスポンス形。companion が source 候補の machineId / 利用可能ソースを把握する。
export type MachineInfo = {
  machineId: string
  label: string
  availableSources: string[]
}

// `<cmd> --version` を実行できるかでツールの有無を判定する。
// Windows では PATH 解決が `.cmd` ラッパーを要求しうるので `<cmd>.cmd` もフォールバックで試す。
export async function hasCli(cmd: string): Promise<boolean> {
  const candidates = process.platform === 'win32' ? [cmd, `${cmd}.cmd`] : [cmd]
  for (const c of candidates) {
    try {
      await pexec(c, ['--version'])
      return true
    } catch {
      // 次の候補を試す
    }
  }
  return false
}

export async function machineInfo(): Promise<MachineInfo> {
  if (machineCache && Date.now() - machineCache.at < MACHINE_TTL_MS) return machineCache.data
  const host = hostname()
  const machineId = host
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9]+/g, '-')
  const available: string[] = []
  if (await hasCli('claude')) available.push('claude-code')
  if (await hasCli('codex')) available.push('codex')
  const data: MachineInfo = { machineId, label: host, availableSources: available }
  machineCache = { data, at: Date.now() }
  return data
}
