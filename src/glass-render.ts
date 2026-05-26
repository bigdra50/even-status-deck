import type { Config, MachineCfg } from './config'
import type { ClaudeLimits, CodexLimits, MachineInfo, Usage } from './data'
import { sourceById } from './sources'

// glass 描画の純粋ロジック (bridge 非依存)。glass.ts が状態と bridge 配線を持ち、ここを呼ぶ。
export type GView = 'summary' | 'claude' | 'codex'
export type GlassData = {
  config: Config
  machine: MachineInfo | null
  claude: ClaudeLimits | null
  codex: CodexLimits | null
  usage: Usage | null
}

function activeCfg(d: GlassData): MachineCfg | null {
  const id = d.config.activeMachine
  return id ? (d.config.machines[id] ?? null) : null
}

// progress bar: ━(filled) / ─(empty)。DESIGN.md §5 準拠。
export function bar(percent: number, width = 12): string {
  const p = Math.max(0, Math.min(100, percent))
  const filled = Math.round((p / 100) * width)
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

// reset までの残り時間 (例: 2h13m / 3d4h / now)。
function until(v: string | number | null | undefined): string {
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

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

// 288px / line-height 27px ≒ 10 行。ヒントを最下端に置くため本文との間を空行で埋める。
// 本文が長くて収まらない場合はそのまま本文直後に出す (画面外に押し出さない)。
const MAX_ROWS = 10
function withBottomHint(lines: string[], hint: string | null): string {
  if (!hint) return lines.join('\n')
  const blanks = MAX_ROWS - lines.length - 1
  const padded = blanks > 0 ? [...lines, ...Array<string>(blanks).fill(''), hint] : [...lines, hint]
  return padded.join('\n')
}

function metricName(srcId: string, metricId: string): string {
  return sourceById(srcId)?.metrics.find((m) => m.id === metricId)?.name ?? metricId
}

// summary 用の値 (companion の glassPreviewHtml と同じ見せ方)。
function metricValue(d: GlassData, srcId: string, metricId: string): string {
  const { claude, codex, usage } = d
  if (srcId === 'claude-code') {
    if (metricId === 'session') return claude?.five_hour ? `${claude.five_hour.utilization}%` : '—'
    if (metricId === 'weekly') return claude?.seven_day ? `${claude.seven_day.utilization}%` : '—'
    if (metricId === 'sonnet')
      return claude?.seven_day_sonnet ? `${claude.seven_day_sonnet.utilization}%` : '—'
    if (metricId === 'opus')
      return claude?.seven_day_opus ? `${claude.seven_day_opus.utilization}%` : '—'
    if (metricId === 'cost')
      return usage?.estCostUsd != null ? `$${Math.round(usage.estCostUsd)}` : '—'
    if (metricId === 'msgs') return usage?.messages != null ? String(usage.messages) : '—'
  } else if (srcId === 'codex') {
    if (metricId === '5h') return codex?.primary ? `${codex.primary.usedPercent}%` : '—'
    if (metricId === 'weekly') return codex?.secondary ? `${codex.secondary.usedPercent}%` : '—'
  }
  return '—'
}

// 詳細ビュー用の 1 行データ。percent が null のものは bar を出さない (cost / msgs)。
type Row = { percent: number | null; value: string; reset: string }
function metricRow(d: GlassData, srcId: string, metricId: string): Row {
  const { claude, codex, usage } = d
  if (srcId === 'claude-code') {
    if (metricId === 'cost')
      return {
        percent: null,
        value: usage?.estCostUsd != null ? `$${Math.round(usage.estCostUsd)}` : 'n/a',
        reset: '',
      }
    if (metricId === 'msgs')
      return {
        percent: null,
        value: usage?.messages != null ? String(usage.messages) : 'n/a',
        reset: '',
      }
    const win =
      metricId === 'session'
        ? claude?.five_hour
        : metricId === 'weekly'
          ? claude?.seven_day
          : metricId === 'sonnet'
            ? claude?.seven_day_sonnet
            : metricId === 'opus'
              ? claude?.seven_day_opus
              : undefined
    if (!win) return { percent: null, value: 'n/a', reset: '' }
    return { percent: win.utilization, value: `${win.utilization}%`, reset: until(win.resets_at) }
  }
  if (srcId === 'codex') {
    const win = metricId === '5h' ? codex?.primary : codex?.secondary
    if (!win) return { percent: null, value: 'n/a', reset: '' }
    return { percent: win.usedPercent, value: `${win.usedPercent}%`, reset: until(win.resetsAt) }
  }
  return { percent: null, value: 'n/a', reset: '' }
}

// summary: 有効ソース × 有効 metric を各 1 行に圧縮 (config 駆動)。
function renderSummary(d: GlassData): string {
  const mc = activeCfg(d)
  const avail = d.machine?.availableSources ?? []
  const lines = ['AI Usage']
  if (mc) {
    for (const id of mc.sourceOrder) {
      const scfg = mc.sources[id]
      const src = sourceById(id)
      if (!scfg?.enabled || !avail.includes(id) || !src) continue
      const ms = scfg.metrics
        .filter((m) => m.enabled)
        .map((m) => `${metricName(id, m.id)} ${metricValue(d, id, m.id)}`)
        .join('  ')
      lines.push(`${src.name}  ${ms}`)
    }
  }
  if (lines.length === 1) lines.push('(no metric)')
  return withBottomHint(lines, d.config.glassHints ? 'swipe: 詳細  tap: 戻る' : null)
}

// 詳細: そのソースの全 metric を bar 表示 (DESIGN.md §5)。
function renderDetail(d: GlassData, srcId: string): string {
  const src = sourceById(srcId)
  if (!src) return renderSummary(d)
  const lines = [src.name]
  for (const m of src.metrics) {
    const r = metricRow(d, srcId, m.id)
    if (r.percent != null) {
      lines.push(`${pad(m.name, 8)} ${bar(r.percent)} ${r.value}${r.reset ? ` ${r.reset}` : ''}`)
    } else {
      lines.push(`${pad(m.name, 8)} ${r.value}`)
    }
  }
  return withBottomHint(lines, d.config.glassHints ? 'swipe / tap: 戻る' : null)
}

export function renderGlass(view: GView, d: GlassData): string {
  if (view === 'claude') return renderDetail(d, 'claude-code')
  if (view === 'codex') return renderDetail(d, 'codex')
  return renderSummary(d)
}

// 有効ソースに応じて詳細ビューを動的に構成する ([summary, claude?, codex?])。
export function buildViews(d: GlassData): GView[] {
  const out: GView[] = ['summary']
  const mc = activeCfg(d)
  const avail = d.machine?.availableSources ?? []
  for (const id of mc?.sourceOrder ?? []) {
    if (!avail.includes(id) || !mc?.sources[id]?.enabled) continue
    if (id === 'claude-code') out.push('claude')
    else if (id === 'codex') out.push('codex')
  }
  return out
}
