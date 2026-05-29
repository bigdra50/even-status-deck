// Codex CLI rate limit provider。`codex app-server` を spawn し JSON-RPC で
// account/rateLimits/read を 1 回叩いて primary/secondary の使用率を取る (experimental)。
// vite.config.ts:94-143,314-335 の fetchCodexLimits / codexProvider / codexCache /
// fmtReset / pctSegment を移植。oauth/keychain 系は持たない。
//
// 二重 spawn 抑止 (同時 /api/status 多発) は status.ts の inflight dedup が担う。
// codexCache のモジュールスコープ TTL は単独実行 (vite middleware から直接呼ぶ等) でも
// 無駄な spawn を避けるための保険として残す。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { hasCli } from '../machine.ts'
import type { Group, ProviderCtx, Segment } from '../types.ts'

const CODEX_TTL_MS = 60_000
let codexCache: { data: unknown; at: number } | null = null

// reset までの残り時間を "2h13m" 形式に整形する。秒 (number) と ISO 文字列の両方を受ける。
function fmtReset(v: string | number | null | undefined): string {
  if (v == null) return ''
  const t = typeof v === 'number' ? v * 1000 : new Date(v).getTime()
  const ms = t - Date.now()
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d${h % 24}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

// 使用率 (%) + reset を持つ segment を作る。pct が無ければ value="n/a"・bar なし。
function pctSegment(
  id: string,
  label: string,
  pct: number | undefined,
  reset: string | number | null | undefined,
  defaultEnabled: boolean,
): Segment {
  if (typeof pct === 'number') {
    return { id, label, value: `${pct}%`, percent: pct, reset: fmtReset(reset), defaultEnabled }
  }
  return { id, label, value: 'n/a', defaultEnabled }
}

function fetchCodexLimits(): Promise<unknown> {
  if (codexCache && Date.now() - codexCache.at < CODEX_TTL_MS) {
    return Promise.resolve(codexCache.data)
  }
  return new Promise((resolve) => {
    // Windows: shell:false のまま `.cmd` の ENOENT を避けるため `cmd /c codex app-server` 経由 (I-5)。
    const spawnArgs: [string, string[]] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'codex', 'app-server']]
        : ['codex', ['app-server']]
    const proc = spawn(...spawnArgs, { stdio: ['pipe', 'pipe', 'ignore'] })
    const rl = createInterface({ input: proc.stdout })
    let done = false
    const send = (m: unknown) => proc.stdin.write(`${JSON.stringify(m)}\n`)
    const finish = (data: unknown, ok: boolean) => {
      if (done) return
      done = true
      try {
        proc.kill()
      } catch {
        /* noop */
      }
      if (ok) codexCache = { data, at: Date.now() }
      resolve(data)
    }
    rl.on('line', (line) => {
      let msg: { id?: number; error?: unknown; result?: { rateLimits?: { primary?: unknown } } }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id === 0) {
        send({ method: 'initialized' })
        // 認証完了を待つ (500ms だと primary が null になることがある)。
        setTimeout(() => send({ id: 1, method: 'account/rateLimits/read', params: {} }), 1500)
      } else if (msg.id === 1) {
        if (msg.error) finish({ error: 'codex rpc error' }, false)
        else {
          const rl2 = msg.result?.rateLimits
          finish(rl2 ?? { error: 'no rateLimits' }, Boolean(rl2?.primary))
        }
      }
    })
    // ENOENT 等の spawn 失敗を捕捉してクラッシュさせない (既存挙動踏襲)。
    proc.on('error', () => finish({ error: 'codex spawn failed' }, false))
    setTimeout(() => finish({ error: 'codex timeout' }, false), 9000)
    send({
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'eveng2-toolbar', title: 'Statusline', version: '0.1.0' } },
    })
  })
}

export async function codexProvider(_ctx: ProviderCtx): Promise<Group | null> {
  if (!(await hasCli('codex'))) return null
  const x = (await fetchCodexLimits()) as {
    error?: unknown
    primary?: { usedPercent?: number; resetsAt?: number }
    secondary?: { usedPercent?: number; resetsAt?: number }
  }
  // codex は rate limit を一括取得するので、失敗時は group 単位の state="error" (両 segment が継承)。
  const group: Group = {
    id: 'codex',
    label: 'Codex',
    segments: [
      pctSegment('5h', '5h', x.primary?.usedPercent, x.primary?.resetsAt, true),
      pctSegment('weekly', 'Weekly', x.secondary?.usedPercent, x.secondary?.resetsAt, true),
    ],
  }
  if (x.error != null || x.primary == null) {
    group.state = 'error'
    group.message = 'rate limit unavailable'
  }
  return group
}
