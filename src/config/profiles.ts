import { BUILTIN_SOURCE_ID, DEFAULT_PROFILE_ID } from './constants'
import { genProfileId } from './ids'
import type {
  Config,
  GlassLayout,
  GlassPage,
  Profile,
  ProfileView,
  SourceDef,
  ViewGroup,
} from './types'

export function emptyProfileView(): ProfileView {
  return { groups: {}, groupOrder: [] }
}

export function emptyDefaultProfile(): Profile {
  return { id: DEFAULT_PROFILE_ID, name: 'Default', enabledSourceIds: [], view: emptyProfileView() }
}

// GlassLayout を deep copy する (rows の各行配列と customLabels を新規化)。
export function cloneGlassLayout(lay: GlassLayout): GlassLayout {
  const customLabels: Record<string, { text: string }> = {}
  for (const [id, v] of Object.entries(lay.customLabels)) customLabels[id] = { text: v.text }
  return { rows: lay.rows.map((r) => [...r]), customLabels }
}

// active profile を返す (見つからなければ先頭、それも無ければ Default を生成して補う)。
export function activeProfile(cfg: Config): Profile {
  const found = cfg.profiles.find((p) => p.id === cfg.activeProfileId)
  if (found) return found
  if (cfg.profiles.length) return cfg.profiles[0] as Profile
  const def = emptyDefaultProfile()
  cfg.profiles.push(def)
  cfg.activeProfileId = def.id
  return def
}

export function activeView(cfg: Config): ProfileView {
  return activeProfile(cfg).view
}

// explicit デッキを解決する。pages 優先、無ければ glassLayout を 1 枚として吸収、両方無しは空 (=auto デッキ)。
// auto デッキ (summary+detail) は render-time 仮想ページなので呼び出し側 (buildRuntimePages) が生成する。
export function resolvePages(view: ProfileView): GlassPage[] {
  if (view.pages?.length) return view.pages
  if (view.glassLayout) return [{ id: 'page-1', name: 'Page 1', layout: view.glassLayout }]
  return []
}

// active profile の enabledSourceIds に含まれる source (builtin 含む) だけを返す (fetch 範囲)。
// store はこれを fetch 対象にする。MVP は Default=全 source なので結果は cfg.sources と同じ。
export function enabledSources(cfg: Config): SourceDef[] {
  const enabled = new Set(activeProfile(cfg).enabledSourceIds)
  return cfg.sources.filter((s) => s.id === BUILTIN_SOURCE_ID || enabled.has(s.id))
}

// active profile で source が有効か (fetch/表示対象か)。builtin は常に true (fetch 範囲に必須)。
export function isSourceEnabled(cfg: Config, sourceId: string): boolean {
  if (sourceId === BUILTIN_SOURCE_ID) return true
  return activeProfile(cfg).enabledSourceIds.includes(sourceId)
}

// active profile での source の有効/無効を切り替える。builtin は常に有効 (変更不可)。
// OFF にした source は fetch されず glass/Items から消えるが、view (並び/可視性) は保持する
// (再 ON や profile 切替で復元)。これが「業務 profile は私用 Mac を fetch しない」を実現する。
export function setSourceEnabled(cfg: Config, sourceId: string, enabled: boolean): void {
  if (sourceId === BUILTIN_SOURCE_ID) return
  const prof = activeProfile(cfg)
  const has = prof.enabledSourceIds.includes(sourceId)
  if (enabled && !has) prof.enabledSourceIds.push(sourceId)
  else if (!enabled && has) {
    prof.enabledSourceIds = prof.enabledSourceIds.filter((id) => id !== sourceId)
  }
}

export function sourceById(cfg: Config, id: string): SourceDef | undefined {
  return cfg.sources.find((s) => s.id === id)
}

// group の表示名 override (素材)。未設定は undefined。effective 名 = これ ?? liveLabel で解決する。
export function groupDisplayName(
  cfg: Config,
  sourceId: string,
  groupId: string,
): string | undefined {
  return cfg.groups[sourceId]?.[groupId]?.displayName
}

// ── profile 操作 (Phase 2: プリセット切替) ──
// active profile を切替える (見つからなければ無視)。fetch 範囲 (enabledSources) が変わるため、
// 呼び出し側で saveConfig → setSourcesFromConfig → render を続ける。
export function setActiveProfile(cfg: Config, id: string): void {
  if (cfg.profiles.some((p) => p.id === id)) cfg.activeProfileId = id
}

// 空 view の新規 profile を追加し、active にする。enabledSourceIds は builtin + 全 server を既定で
// 有効化する(新規 profile でも何も出ないと混乱するため)。ただし client source(weather/geoinfo 等)は
// opt-in なので含めない(さもないと preset 追加だけで位置許可ダイアログ/外部 fetch が走る)。追加した profile を返す。
export function addProfile(cfg: Config, name: string): Profile {
  const prof: Profile = {
    id: genProfileId(),
    name: name || 'New preset',
    enabledSourceIds: cfg.sources.filter((s) => s.kind !== 'client').map((s) => s.id),
    view: emptyProfileView(),
  }
  cfg.profiles.push(prof)
  cfg.activeProfileId = prof.id
  return prof
}

// ProfileView を deep copy する (複製時の参照共有を断つ)。ViewGroup / GroupRef / GlassLayout / pages
// すべて新規オブジェクトにし、複製後の編集が元 profile に波及しないようにする。
function cloneView(view: ProfileView): ProfileView {
  const groups: Record<string, Record<string, ViewGroup>> = {}
  for (const [sid, gmap] of Object.entries(view.groups)) {
    groups[sid] = {}
    for (const [gid, vg] of Object.entries(gmap)) {
      groups[sid][gid] = { ...vg, segments: { ...vg.segments } }
    }
  }
  const next: ProfileView = {
    groups,
    groupOrder: view.groupOrder.map((r) => ({ ...r })),
  }
  if (view.glassLayout) next.glassLayout = cloneGlassLayout(view.glassLayout)
  if (view.pages) {
    next.pages = view.pages.map((p) => ({
      id: p.id,
      name: p.name,
      layout: cloneGlassLayout(p.layout),
    }))
  }
  return next
}

// active profile を複製して active にする。view は deep copy (参照共有しない = 独立に編集可能)。
// enabledSourceIds も複製する (同じ fetch 範囲から始める)。
export function duplicateActiveProfile(cfg: Config, name?: string): Profile {
  const src = activeProfile(cfg)
  const prof: Profile = {
    id: genProfileId(),
    name: name || `${src.name} copy`,
    enabledSourceIds: [...src.enabledSourceIds],
    view: cloneView(src.view),
  }
  cfg.profiles.push(prof)
  cfg.activeProfileId = prof.id
  return prof
}

// profile を削除する (Default は不可、最後の 1 個も不可)。active を消したら別 profile を active にする。
// 削除したら true。
export function removeProfile(cfg: Config, id: string): boolean {
  if (id === DEFAULT_PROFILE_ID) return false
  if (cfg.profiles.length <= 1) return false
  const idx = cfg.profiles.findIndex((p) => p.id === id)
  if (idx < 0) return false
  cfg.profiles.splice(idx, 1)
  if (cfg.activeProfileId === id) {
    cfg.activeProfileId = cfg.profiles[0]?.id ?? DEFAULT_PROFILE_ID
  }
  return true
}

// profile 名を変更する (空名は無視)。
export function renameProfile(cfg: Config, id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  const prof = cfg.profiles.find((p) => p.id === id)
  if (prof) prof.name = trimmed
}
