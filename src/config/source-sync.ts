import type { StatusDoc } from '../status-types'
import { defaultCategory } from '../taxonomy'
import { defaultShowGroupLabel } from './ids'
import { activeView } from './profiles'
import type { Config } from './types'

// status を該当ソースの素材 + active profile の view に反映する。新規 group/segment は素材へ追加し、
// active profile の view に既定 ON + groupOrder 末尾へ。既存トグル・並び順は保持。追加があれば true。
export function syncSourceWithStatus(cfg: Config, sourceId: string, status: StatusDoc): boolean {
  let changed = false
  if (!cfg.groups[sourceId]) cfg.groups[sourceId] = {}
  const meta = cfg.groups[sourceId]
  const view = activeView(cfg)
  view.groups[sourceId] ??= {}
  const vgroups = view.groups[sourceId]
  for (const g of status.groups) {
    let gm = meta[g.id]
    if (!gm) {
      gm = { segments: [] }
      meta[g.id] = gm
      changed = true
    }
    // live label を merge identity として内部記録 (offline でも見出しマージが揺れないため)。
    // label は静的リテラル規約 (display-identity 参照) なので実質初回のみ書く = churn 無し。
    // 非空→空への変化は削除 (旧見出しで誤マージし続けない)。
    if (g.label) {
      if (gm.lastLabel !== g.label) {
        gm.lastLabel = g.label
        changed = true
      }
    } else if (gm.lastLabel !== undefined) {
      delete gm.lastLabel
      changed = true
    }
    let vg = vgroups[g.id]
    if (!vg) {
      vg = { enabled: true, showDefaultLabel: defaultShowGroupLabel(g.id), segments: {} }
      vgroups[g.id] = vg
      // groupOrder に同 ref が既にあれば push しない (groups と groupOrder の一時的不整合での二重登録防止)。
      if (!view.groupOrder.some((r) => r.sourceId === sourceId && r.groupId === g.id)) {
        view.groupOrder.push({ sourceId, groupId: g.id })
      }
      changed = true
    }
    for (const seg of g.segments) {
      if (!gm.segments.some((s) => s.id === seg.id)) {
        // 新規 segment 素材化時に category を seed (defaultCategory: groupId|segId 既定、未知=custom)。
        gm.segments.push({ id: seg.id, category: defaultCategory(g.id, seg.id) })
        changed = true
      }
      if (vg.segments[seg.id] === undefined) {
        vg.segments[seg.id] = seg.defaultEnabled ?? true
        changed = true
      }
    }
  }
  return changed
}
