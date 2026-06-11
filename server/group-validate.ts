// status.ts (JS plugin autoload) と subprocess.ts (subprocess provider の単一 Group 出力) の
// 両方が使う最小限の Group 形状検証。vite.config.ts:452-459 の単一 Group 検証を移植。
// parseStatusDoc (../src/status-types.ts) と異なり、サニタイズはせず形状チェックのみで
// 入力オブジェクトをそのまま返す (provider/subprocess が組み立てた Group をそのまま使う想定)。
import type { Group } from './types.ts'

export function asGroup(x: unknown): Group | null {
  if (!x || typeof x !== 'object') return null
  const g = x as { id?: unknown; label?: unknown; segments?: unknown }
  if (typeof g.id !== 'string' || typeof g.label !== 'string' || !Array.isArray(g.segments)) {
    return null
  }
  return x as Group
}
