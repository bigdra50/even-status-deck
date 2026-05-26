// Source / Metric の静的定義。実値は data.ts の API から取得する。
export type Metric = { id: string; name: string }
export type Source = { id: string; name: string; metrics: Metric[] }

export const SOURCES: Source[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    metrics: [
      { id: 'session', name: 'Session' },
      { id: 'weekly', name: 'Weekly' },
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' },
      { id: 'cost', name: 'Cost' },
      { id: 'msgs', name: 'Msgs' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    metrics: [
      { id: '5h', name: '5h' },
      { id: 'weekly', name: 'Weekly' },
    ],
  },
  { id: 'gemini', name: 'Gemini', metrics: [] },
]

// 既定で有効にする metric (初回設定生成時)
export const DEFAULT_ENABLED_METRICS = new Set(['session', 'weekly', 'cost', '5h'])

export function sourceById(id: string): Source | undefined {
  return SOURCES.find((s) => s.id === id)
}
