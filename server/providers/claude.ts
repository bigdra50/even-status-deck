// Claude Code 累積トークン (今日分) を ~/.claude/projects/**/*.jsonl から集計し、
// cost / msgs の 2 segment を返す builtin provider。
// oauth/keychain/rate-limit (fetchClaudeLimits/pctSegment/markError/session・weekly・
// sonnet・opus) は移植しない。usage 集計のみの純ローカル実装。
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasCli } from '../machine.ts'
import type { Group, ProviderCtx, Segment } from '../types.ts'

// 1M tokens あたりの USD 単価 (model 別)。
type Pricing = { input: number; output: number; cacheWrite: number; cacheRead: number }
const PRICING: Record<string, Pricing> = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
}

function pricingFor(model: string): Pricing {
  if (model.includes('opus')) return PRICING.opus
  if (model.includes('haiku')) return PRICING.haiku
  return PRICING.sonnet
}

// ローカルタイムの YYYY-MM-DD。今日分の usage 行を絞り込むキーに使う。
function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

type UsageLine = {
  type?: string
  timestamp?: string
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

type UsageResult = {
  date: string
  messages?: number
  input?: number
  output?: number
  cacheWrite?: number
  cacheRead?: number
  estCostUsd?: number
  error?: string
}

async function collectUsage(): Promise<UsageResult> {
  const root = join(homedir(), '.claude', 'projects')
  const todayKey = localDateKey(new Date())
  const sinceMs = Date.now() - 36 * 3600 * 1000
  let rel: string[]
  try {
    rel = (await readdir(root, { recursive: true })).filter((p) => p.endsWith('.jsonl'))
  } catch {
    return { date: todayKey, error: 'no ~/.claude/projects' }
  }
  let input = 0
  let output = 0
  let cacheWrite = 0
  let cacheRead = 0
  let messages = 0
  let cost = 0
  for (const r of rel) {
    const file = join(root, r)
    try {
      const st = await stat(file)
      if (st.mtimeMs < sinceMs) continue
      const text = await readFile(file, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue
        let obj: UsageLine
        try {
          obj = JSON.parse(line) as UsageLine
        } catch {
          continue
        }
        const u = obj.message?.usage
        if (obj.type !== 'assistant' || !u || !obj.timestamp) continue
        if (localDateKey(new Date(obj.timestamp)) !== todayKey) continue
        const model = obj.message?.model ?? 'sonnet'
        const inT = u.input_tokens ?? 0
        const outT = u.output_tokens ?? 0
        const cwT = u.cache_creation_input_tokens ?? 0
        const crT = u.cache_read_input_tokens ?? 0
        input += inT
        output += outT
        cacheWrite += cwT
        cacheRead += crT
        messages += 1
        const p = pricingFor(model)
        cost += (inT * p.input + outT * p.output + cwT * p.cacheWrite + crT * p.cacheRead) / 1e6
      }
    } catch {
      /* skip unreadable */
    }
  }
  return {
    date: todayKey,
    messages,
    input,
    output,
    cacheWrite,
    cacheRead,
    estCostUsd: Math.round(cost * 100) / 100,
  }
}

export async function claudeProvider(_ctx: ProviderCtx): Promise<Group | null> {
  if (!(await hasCli('claude'))) return null
  const usage = await collectUsage()
  const segments: Segment[] = [
    {
      id: 'cost',
      label: 'Cost',
      value: usage.estCostUsd != null ? `$${Math.round(usage.estCostUsd)}` : 'n/a',
      defaultEnabled: true,
    },
    {
      id: 'msgs',
      label: 'Msgs',
      value: usage.messages != null ? String(usage.messages) : 'n/a',
      defaultEnabled: false,
    },
  ]
  const group: Group = { id: 'claude-code', label: 'Claude', segments }
  if (usage.error != null) {
    group.state = 'error'
    group.message = 'usage log unavailable'
  }
  return group
}
