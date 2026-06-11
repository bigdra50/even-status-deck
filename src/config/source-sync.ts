import type { Group, StatusDoc } from '../status-types'
import { defaultCategory } from '../taxonomy'
import { defaultShowGroupLabel } from './ids'
import { activeView } from './profiles'
import type { Config, GroupMeta, ProfileView, ViewGroup } from './types'

// live label を merge identity として gm.lastLabel に反映する (offline でも見出しマージが揺れないため)。
// label は静的リテラル規約 (display-identity 参照) なので実質初回のみ書く = churn 無し。
// 非空→空への変化は削除 (旧見出しで誤マージし続けない)。変更があれば true。
function syncLastLabel(gm: GroupMeta, label: string | undefined): boolean {
  if (label) {
    if (gm.lastLabel !== label) {
      gm.lastLabel = label
      return true
    }
    return false
  }
  if (gm.lastLabel !== undefined) {
    delete gm.lastLabel
    return true
  }
  return false
}

// view 側の ViewGroup を確保し、無ければ既定 ON で作成して groupOrder 末尾へ登録する (新規があれば true)。
function ensureViewGroup(
  vgroups: Record<string, ViewGroup>,
  view: ProfileView,
  sourceId: string,
  groupId: string,
): { vg: ViewGroup; changed: boolean } {
  let vg = vgroups[groupId]
  if (vg) return { vg, changed: false }
  vg = { enabled: true, showDefaultLabel: defaultShowGroupLabel(groupId), segments: {} }
  vgroups[groupId] = vg
  // groupOrder に同 ref が既にあれば push しない (groups と groupOrder の一時的不整合での二重登録防止)。
  if (!view.groupOrder.some((r) => r.sourceId === sourceId && r.groupId === groupId)) {
    view.groupOrder.push({ sourceId, groupId })
  }
  return { vg, changed: true }
}

// group 内の各 segment を素材 (gm.segments) と view (vg.segments) へ反映する (新規があれば true)。
function syncGroupSegments(gm: GroupMeta, vg: ViewGroup, groupId: string, g: Group): boolean {
  let changed = false
  for (const seg of g.segments) {
    if (!gm.segments.some((s) => s.id === seg.id)) {
      // 新規 segment 素材化時に category を seed (defaultCategory: groupId|segId 既定、未知=custom)。
      gm.segments.push({ id: seg.id, category: defaultCategory(groupId, seg.id) })
      changed = true
    }
    if (vg.segments[seg.id] === undefined) {
      vg.segments[seg.id] = seg.defaultEnabled ?? true
      changed = true
    }
  }
  return changed
}

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
    if (syncLastLabel(gm, g.label)) changed = true
    const { vg, changed: vgChanged } = ensureViewGroup(vgroups, view, sourceId, g.id)
    if (vgChanged) changed = true
    if (syncGroupSegments(gm, vg, g.id, g)) changed = true
  }
  return changed
}
