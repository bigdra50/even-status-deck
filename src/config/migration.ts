import { defaultImuConfig, type ImuConfig } from '../imu'
import type { VisibilityCond } from '../visibility/keys'
import {
  AIRQUALITY_SOURCE_ID,
  BUILTIN_SOURCE_ID,
  CONFIG_VERSION,
  DEFAULT_PROFILE_ID,
  GEOCODE_SOURCE_ID,
  GEOINFO_SOURCE_ID,
  LOCATION_PLACE_GROUP_ID,
  LOCATION_SOURCE_ID,
  LOCATION_WEATHER_GROUP_ID,
  PLACES_SOURCE_ID,
  WEATHER_SOURCE_ID,
} from './constants'
import { emptyConfig, ensureBuiltin, ensureClientLocation } from './defaults'
import { defaultShowGroupLabel, genSourceId } from './ids'
import { backfillPages, consolidateClock, normalizeGlassLayout } from './layout'
import {
  normalizeDisplayMeta,
  normalizeMetaVisibilityAll,
  normalizeOptionsAll,
  normalizeProfileView,
  normalizeRemovedViews,
  normalizeSourceUrls,
} from './normalize'
import { normalizePlaces, PLACES_GROUP_ID } from './places'
import { activeProfile, emptyDefaultProfile } from './profiles'
import type {
  Config,
  GAlign,
  GroupMeta,
  GroupRef,
  ProfileView,
  SegMeta,
  SourceDef,
  SourceKind,
  ViewGroup,
} from './types'

// ── 移行 ──
// v3 の旧型 (素材と表示が混在していた GroupCfg/SegCfg)。migrate で素材 (GroupMeta) と
// view (ViewGroup) へ分離する。
type OldSegCfg = { id: string; enabled?: boolean; visibility?: VisibilityCond; format?: string }
type OldGroupCfg = {
  enabled?: boolean
  expanded?: boolean
  align?: GAlign
  showDefaultLabel?: boolean
  segments?: OldSegCfg[]
}
// v1/v2 (machines マップ)。URL・トグル・並び順を保持。
type OldMachine = {
  id?: string
  label?: string
  url?: string
  sourceOrder?: string[]
  sources?: Record<string, { enabled?: boolean; expanded?: boolean; metrics?: OldSegCfg[] }>
}

// 任意 version の生 config を v5 へ移行する。export は単体テスト用(loadConfig は bridge 依存で叩けない)。
export function migrate(parsed: Record<string, unknown>): Config {
  if (parsed.version === CONFIG_VERSION) return migrateV5Same(parsed as unknown as Config)
  if (parsed.version === 4) return migrateV5Same(parsed as unknown as Config) // v4→v5 は additive 同型 (backfillPages が pages を生やす)
  if (parsed.version === 3) return migrateV3ToV5(parsed as unknown as V3Config)
  return migrateLegacyToV5(parsed)
}

// v4/v5 同型: additive 正規化を流す (素材/profile 構造は既に整っている前提)。pages は backfillPages が補完。
function migrateV5Same(c: Config): Config {
  c.profiles ??= []
  if (!c.profiles.length) c.profiles.push(emptyDefaultProfile())
  c.activeProfileId ??= c.profiles[0]?.id ?? DEFAULT_PROFILE_ID
  c.groups ??= {}
  c.sources ??= []
  for (const s of c.sources) normalizeSourceUrls(s)
  ensureBuiltin(c)
  migrateLocationSourcesMerge(c) // 旧 5 location source → client.location(2 group)。ensureClientLocation を内包
  ensureClientLocation(c)
  migrateDropPlaceNav(c) // 距離/方位ナビ(#42)撤廃: place group の pl_xxxx/here orphan を掃除(geofence は温存)
  normalizePlaces(c)
  c.imu ??= defaultImuConfig()
  delete (c as Record<string, unknown>).batteryRate
  delete (c as Record<string, unknown>).glassHints
  normalizeMetaVisibilityAll(c) // 素材 segment の visibility を複合形式へ正規化
  normalizeOptionsAll(c) // 素材 segment / source の表示オプションを sanitize (#36)
  for (const p of c.profiles) normalizeProfileView(p)
  migrateMacGroupToSystem(c) // OD-1: server source の system provider group id 'mac' → 'system'
  consolidateClock(c)
  normalizeRemovedViews(c) // tombstone を間引き (壊れていれば破棄)
  normalizeDisplayMeta(c) // 表示モデル Phase1。group id remap の「後」に呼ぶこと (下記ヘルパ参照)
  for (const p of c.profiles) backfillPages(p.view) // glassLayout→pages[0] 投影。全 glassLayout remap の後・prune の前
  pruneOrphans(c) // pages[].layout の orphan source chip も掃除
  c.version = CONFIG_VERSION
  return c
}

// OD-1 移行: 旧 macSystemProvider の group id 'mac' を新クロスプラットフォーム system provider の
// 'system' に付け替える。server source の素材 (cfg.groups[sid]) と全 profile の view.groups[sid] /
// view.groupOrder / glassLayout の segKey を、配置/順序を保ったまま remap する。
// 冪等: 同じ source に既に 'system' group があれば remap しない (現行 system 配置を clobber しない)。
// builtin source は対象外 ('mac' group を持たない。clock/g2 のみ)。
const SYSTEM_GROUP_OLD_ID = 'mac'
const SYSTEM_GROUP_ID = 'system'
function migrateMacGroupToSystem(c: Config): void {
  for (const src of c.sources) {
    if (src.kind !== 'server') continue
    const sid = src.id
    // 素材 (GroupMeta): 'mac' があり 'system' が無いときだけ rename (clobber 回避)。
    const meta = c.groups[sid]
    if (meta?.[SYSTEM_GROUP_OLD_ID] && !meta[SYSTEM_GROUP_ID]) {
      meta[SYSTEM_GROUP_ID] = meta[SYSTEM_GROUP_OLD_ID]
      delete meta[SYSTEM_GROUP_OLD_ID]
    }
    for (const p of c.profiles) {
      // view.groups[sid]: ViewGroup を 'mac' → 'system' へ (可視性/展開/segment 可視性を保つ)。
      const vgroups = p.view.groups[sid]
      if (vgroups?.[SYSTEM_GROUP_OLD_ID] && !vgroups[SYSTEM_GROUP_ID]) {
        vgroups[SYSTEM_GROUP_ID] = vgroups[SYSTEM_GROUP_OLD_ID]
        delete vgroups[SYSTEM_GROUP_OLD_ID]
      }
      // groupOrder: {sourceId:sid, groupId:'mac'} の参照を 'system' へ (順序を保つ)。
      // 同 source に既に 'system' ref があれば 'mac' ref は捨てる (重複防止。normalizeProfileView と整合)。
      const hasSystemRef = p.view.groupOrder.some(
        (r) => r.sourceId === sid && r.groupId === SYSTEM_GROUP_ID,
      )
      p.view.groupOrder = p.view.groupOrder.flatMap((r) => {
        if (r.sourceId !== sid || r.groupId !== SYSTEM_GROUP_OLD_ID) return [r]
        if (hasSystemRef) return []
        return [{ sourceId: sid, groupId: SYSTEM_GROUP_ID }]
      })
      // glassLayout.rows: segKey (sid|mac|seg) の groupId を 'system' へ (配置を保つ)。
      const lay = p.view.glassLayout
      if (lay) {
        lay.rows = lay.rows.map((row) =>
          row.map((k) => reKeyGroupId(k, sid, SYSTEM_GROUP_OLD_ID, SYSTEM_GROUP_ID)),
        )
      }
    }
  }
}

// segKey (sourceId|groupId|segId) の groupId 部分を付け替える。
// sourceId が一致しない / 形式が segKey でない (custom ラベル / @right 等) なら素通し。
function reKeyGroupId(key: string, sourceId: string, fromGid: string, toGid: string): string {
  const parts = key.split('|')
  if (parts.length < 3 || parts[0] !== sourceId || parts[1] !== fromGid) return key
  parts[1] = toGid
  return parts.join('|')
}

// 旧 location source(1 source=1 group) → 統合先 client.location の group へのマッピング。
// weather + airquality → group 'weather'(気象+大気質)、geocode + geoinfo + places(nav) → group 'place'。
// segment id は集約先で衝突しない(各 source の seg id は重複しない)。
const LOCATION_MERGE_MAP: { src: string; grp: string; newGrp: string }[] = [
  { src: WEATHER_SOURCE_ID, grp: 'weather', newGrp: LOCATION_WEATHER_GROUP_ID },
  { src: AIRQUALITY_SOURCE_ID, grp: 'airquality', newGrp: LOCATION_WEATHER_GROUP_ID },
  { src: GEOCODE_SOURCE_ID, grp: 'geocode', newGrp: LOCATION_PLACE_GROUP_ID },
  { src: GEOINFO_SOURCE_ID, grp: 'geoinfo', newGrp: LOCATION_PLACE_GROUP_ID },
  { src: PLACES_SOURCE_ID, grp: PLACES_GROUP_ID, newGrp: LOCATION_PLACE_GROUP_ID },
]

// 旧 5 location source を 1 つの client.location(2 group: weather/place)へ畳む(group 統合)。
// source id remap に加え group id remap + segment 再グルーピングを伴う。素材・view・groupOrder・
// glassLayout・options・enabledSourceIds の全層を移送する。
// 冪等: 旧 source が 1 つも無ければ no-op(新規/移行後の再実行で安定)。
// codex 条件: disabled だった旧 source 由来の segment は view 非表示(false)で残す(Location 有効化で復活させない)。
function migrateLocationSourcesMerge(c: Config): void {
  const oldIds = new Set(LOCATION_MERGE_MAP.map((m) => m.src))
  if (!c.sources.some((s) => oldIds.has(s.id))) return
  ensureClientLocation(c) // 統合先を確保(origin app_bundled / groups 枠)
  const destGroups = c.groups[LOCATION_SOURCE_ID]

  // 1. 素材(GroupMeta.segments)を統合先 group へマージ(seg id 衝突は先勝ち)。
  for (const { src, grp, newGrp } of LOCATION_MERGE_MAP) {
    const fromMeta = c.groups[src]?.[grp]
    if (!fromMeta) continue
    destGroups[newGrp] ??= { segments: [] }
    const dest = destGroups[newGrp]
    const seen = new Set(dest.segments.map((s) => s.id))
    for (const sm of fromMeta.segments) {
      if (seen.has(sm.id)) continue
      dest.segments.push(sm)
      seen.add(sm.id)
    }
  }

  // 2. options: 旧 source の options バッグを統合先へマージ(field id は非衝突。既存 dest 値を優先)。
  const destSrc = c.sources.find((s) => s.id === LOCATION_SOURCE_ID)
  if (destSrc) {
    for (const { src } of LOCATION_MERGE_MAP) {
      const from = c.sources.find((s) => s.id === src)
      if (from?.options) destSrc.options = { ...from.options, ...(destSrc.options ?? {}) }
    }
  }

  // 3. profile ごとに enabled 状態と view を統合先 group/segment へ落とす。
  for (const p of c.profiles) {
    const enabledOld = new Set(
      LOCATION_MERGE_MAP.filter((m) => p.enabledSourceIds.includes(m.src)).map((m) => m.src),
    )
    const anyEnabled = enabledOld.size > 0

    // 3a. enabledSourceIds: 旧のどれかが有効なら client.location を旧の先頭位置へ挿入。旧は全除去。
    const firstIdx = p.enabledSourceIds.findIndex((sid) => oldIds.has(sid))
    p.enabledSourceIds = p.enabledSourceIds.filter((sid) => !oldIds.has(sid))
    if (anyEnabled && !p.enabledSourceIds.includes(LOCATION_SOURCE_ID)) {
      if (firstIdx >= 0) p.enabledSourceIds.splice(firstIdx, 0, LOCATION_SOURCE_ID)
      else p.enabledSourceIds.push(LOCATION_SOURCE_ID)
    }

    // 3b. view.groups: 旧 ViewGroup を統合先 group へマージ。disabled だった旧 source の segment は
    //     view 非表示(false)に落とす(復活防止)。group enabled は寄与 source のどれかが有効なら true。
    p.view.groups[LOCATION_SOURCE_ID] ??= {}
    const destView = p.view.groups[LOCATION_SOURCE_ID]
    for (const { src, grp, newGrp } of LOCATION_MERGE_MAP) {
      const fromVg = p.view.groups[src]?.[grp]
      if (!fromVg) continue
      const wasEnabled = enabledOld.has(src)
      destView[newGrp] ??= {
        enabled: false,
        segments: {},
        showDefaultLabel: defaultShowGroupLabel(newGrp),
      }
      const dvg = destView[newGrp]
      dvg.enabled = dvg.enabled || (fromVg.enabled ?? true)
      for (const [segId, vis] of Object.entries(fromVg.segments ?? {})) {
        dvg.segments[segId] = wasEnabled ? (vis ?? true) : false
      }
    }
    for (const { src } of LOCATION_MERGE_MAP) delete p.view.groups[src]

    // 3c. groupOrder: {oldSrc, oldGrp} → {client.location, newGrp}。重複は先勝ちで dedupe。
    const seenOrder = new Set<string>()
    p.view.groupOrder = p.view.groupOrder.flatMap((r) => {
      const m = LOCATION_MERGE_MAP.find((x) => x.src === r.sourceId && x.grp === r.groupId)
      const ref: GroupRef = m
        ? { sourceId: LOCATION_SOURCE_ID, groupId: m.newGrp }
        : { sourceId: r.sourceId, groupId: r.groupId }
      const k = `${ref.sourceId}|${ref.groupId}`
      if (seenOrder.has(k)) return []
      seenOrder.add(k)
      return [ref]
    })

    // 3d. glassLayout.rows: segKey の sourceId+groupId を remap。remap した location key だけ dedupe
    //     (@right / customLabel / 他 source key は素通し・dedupe しない = 複数行の @right を保つ)。
    const lay = p.view.glassLayout
    if (lay) {
      const seenKey = new Set<string>()
      lay.rows = lay.rows.map((row) =>
        row.flatMap((k) => {
          const parts = k.split('|')
          const m =
            parts.length >= 3
              ? LOCATION_MERGE_MAP.find((x) => x.src === parts[0] && x.grp === parts[1])
              : undefined
          if (!m) return [k]
          parts[0] = LOCATION_SOURCE_ID
          parts[1] = m.newGrp
          const remapped = parts.join('|')
          if (seenKey.has(remapped)) return []
          seenKey.add(remapped)
          return [remapped]
        }),
      )
    }
  }

  // 4. 旧素材 groups + 旧 SourceDef + tombstone を削除。
  for (const { src } of LOCATION_MERGE_MAP) {
    delete c.groups[src]
    if (c.recentlyRemoved) delete c.recentlyRemoved[src]
  }
  c.sources = c.sources.filter((s) => !oldIds.has(s.id))
}

// 距離/方位ナビ(#42)撤廃に伴う orphan 掃除。既存 user config の place group に焼かれた nav 動的 segment
// (保存地点ごと id=pl_xxxx)と presence segment(id=here)を、素材・全 profile の view・glassLayout から除去する。
// geofence(#43)用の Config.places / profile.geofence / 他 segment の inPlace visibility 条件は温存する
// (地点定義と圏内判定は残す)。migrateLocationSourcesMerge の「後」に呼ぶ(旧 places が place group へ畳まれた後)。
// 冪等: 対象 segment が無ければ no-op。CONFIG_VERSION 据え置き(additive 同様、毎 load 実行で安全)。
function migrateDropPlaceNav(c: Config): void {
  const gid = LOCATION_PLACE_GROUP_ID
  const savedIds = new Set((c.places ?? []).map((p) => p.id))
  // place group の表示 segment のうち nav 由来(pl_ 前置 / here / 保存地点 id)を判定する。
  // 地名/標高/TZ の固定 seg(city/area/region/country/elev/tz/zone)は対象外。
  const isNavSeg = (id: string): boolean =>
    id === 'here' || id.startsWith('pl_') || savedIds.has(id)

  // 1. 素材から除去。
  const meta = c.groups[LOCATION_SOURCE_ID]?.[gid]
  if (meta) meta.segments = meta.segments.filter((s) => !isNavSeg(s.id))

  // 2. 各 profile の view.groups + glassLayout.rows から除去(行位置は保つ=空行も残す)。
  for (const p of c.profiles) {
    const vg = p.view.groups[LOCATION_SOURCE_ID]?.[gid]
    if (vg) for (const id of Object.keys(vg.segments)) if (isNavSeg(id)) delete vg.segments[id]
    const lay = p.view.glassLayout
    if (lay) {
      lay.rows = lay.rows.map((row) =>
        row.filter((k) => {
          const parts = k.split('|')
          return !(parts[0] === LOCATION_SOURCE_ID && parts[1] === gid && isNavSeg(parts[2] ?? ''))
        }),
      )
    }
  }

  // 3. 廃止オプション値(distUnit/bearingStyle)を掃除(無害だが残さない)。
  const src = c.sources.find((s) => s.id === LOCATION_SOURCE_ID)
  if (src?.options) {
    delete src.options.distUnit
    delete src.options.bearingStyle
  }
}

// v3 (素材と表示が混在・単一構成) -> v5。全構成を Default profile の view + enabledSourceIds へ収容する。
type V3Config = {
  version: number
  sources?: Array<{ id: string; kind: SourceKind; label: string; url?: string }>
  groups?: Record<string, Record<string, OldGroupCfg>>
  groupOrder?: GroupRef[]
  glassLayout?: unknown
  imu?: ImuConfig
}
function migrateV3ToV5(old: V3Config): Config {
  const cfg = emptyConfig()
  cfg.imu = old.imu ?? cfg.imu
  // sources: url? を urls[0] へ正規化 (MVP は urls を正)。
  for (const s of old.sources ?? []) {
    if (s.id === BUILTIN_SOURCE_ID) continue // builtin は ensureBuiltin が所有
    const def: SourceDef = { id: s.id, kind: s.kind, label: s.label, urls: s.url ? [s.url] : [] }
    if (s.url) def.url = s.url
    cfg.sources.push(def)
  }
  const def = activeProfile(cfg) // Default profile
  const view = def.view
  // 素材 (format/visibility のみ) と view (enabled/expanded/align/showDefaultLabel + segment 可視性) へ分離。
  for (const [sid, groups] of Object.entries(old.groups ?? {})) {
    if (sid === BUILTIN_SOURCE_ID) {
      // builtin は ensureBuiltin で素材枠を確保済。format/visibility と view を移す。
      splitGroupsInto(cfg, view, sid, groups)
      continue
    }
    cfg.groups[sid] ??= {}
    view.groups[sid] ??= {}
    splitGroupsInto(cfg, view, sid, groups)
  }
  // groupOrder / glassLayout を Default view へ収容。
  view.groupOrder = [...(old.groupOrder ?? [])]
  const lay = normalizeGlassLayout(old.glassLayout)
  if (lay) view.glassLayout = lay
  // 旧 source を Default の enabledSourceIds に集約する(v3 の見た目を維持)。ただし client source
  // (weather/geoinfo 等)は opt-in なので既定 ON にしない(さもないと旧 config の升級で位置許可/外部 fetch が走る)。
  def.enabledSourceIds = cfg.sources.filter((s) => s.kind !== 'client').map((s) => s.id)
  // builtin が先頭に来るよう ensureBuiltin を再適用 (順序 + enabledSourceIds)。
  ensureBuiltin(cfg)
  migrateLocationSourcesMerge(cfg) // 旧 location source があれば畳む(v3 は通常無いが冪等・防御的)
  ensureClientLocation(cfg)
  migrateDropPlaceNav(cfg) // 距離/方位ナビ(#42)撤廃: place group の pl_xxxx/here orphan を掃除(geofence は温存)
  normalizePlaces(cfg)
  normalizeMetaVisibilityAll(cfg)
  for (const p of cfg.profiles) normalizeProfileView(p)
  consolidateClock(cfg)
  normalizeDisplayMeta(cfg) // 表示モデル Phase1: clock 統合の後に category 等を seed (v5Same と同経路)
  for (const p of cfg.profiles) backfillPages(p.view) // glassLayout→pages[0] 投影
  pruneOrphans(cfg)
  return cfg
}

// 旧 GroupCfg 群を素材 (cfg.groups[sid]) と view (view.groups[sid]) へ分配する。
function splitGroupsInto(
  cfg: Config,
  view: ProfileView,
  sid: string,
  groups: Record<string, OldGroupCfg>,
): void {
  cfg.groups[sid] ??= {}
  view.groups[sid] ??= {}
  for (const [gid, gc] of Object.entries(groups)) {
    const meta: GroupMeta = { segments: [] }
    const segVis: Record<string, boolean> = {}
    for (const sc of gc.segments ?? []) {
      const sm: SegMeta = { id: sc.id }
      if (sc.format) sm.format = sc.format
      if (sc.visibility) sm.visibility = sc.visibility
      meta.segments.push(sm)
      segVis[sc.id] = sc.enabled ?? true
    }
    cfg.groups[sid][gid] = meta
    const vg: ViewGroup = { enabled: gc.enabled ?? true, segments: segVis }
    if (gc.expanded) vg.expanded = true
    if (gc.align) vg.align = gc.align
    vg.showDefaultLabel = gc.showDefaultLabel ?? defaultShowGroupLabel(gid)
    view.groups[sid][gid] = vg
  }
}

// v1/v2 (machines マップ) -> v5。素材 + Default profile view を直接構築する。
function migrateLegacyToV5(parsed: Record<string, unknown>): Config {
  const old = parsed as { machines?: Record<string, OldMachine> }
  const cfg = emptyConfig()
  const def = activeProfile(cfg)
  const view = def.view
  for (const [mid, mc] of Object.entries(old.machines ?? {})) {
    const id = mc.id ?? genSourceId() // v2 の不変 ID は保持、v1 は新規採番
    const sdef: SourceDef = {
      id,
      kind: 'server',
      label: mc.label ?? mid,
      urls: mc.url ? [mc.url] : [],
    }
    if (mc.url) sdef.url = mc.url
    cfg.sources.push(sdef)
    const groups: Record<string, OldGroupCfg> = {}
    for (const [gid, scfg] of Object.entries(mc.sources ?? {})) {
      groups[gid] = {
        enabled: scfg.enabled ?? true,
        expanded: scfg.expanded ?? false,
        segments: (scfg.metrics ?? []).map((m) => ({ id: m.id, enabled: m.enabled ?? true })),
      }
    }
    splitGroupsInto(cfg, view, id, groups)
    for (const gid of mc.sourceOrder ?? []) view.groupOrder.push({ sourceId: id, groupId: gid })
  }
  // client source(weather/geoinfo 等)は opt-in なので既定 ON にしない。移行で見た目を変えない対象は
  // builtin + 旧ユーザー source(server)のみ。さもないと旧 config の升級で位置許可/外部 fetch が走る。
  def.enabledSourceIds = cfg.sources.filter((s) => s.kind !== 'client').map((s) => s.id)
  ensureBuiltin(cfg)
  migrateLocationSourcesMerge(cfg) // 旧 location source があれば畳む(legacy は通常無いが冪等・防御的)
  ensureClientLocation(cfg)
  migrateDropPlaceNav(cfg) // 距離/方位ナビ(#42)撤廃: place group の pl_xxxx/here orphan を掃除(geofence は温存)
  normalizePlaces(cfg)
  normalizeMetaVisibilityAll(cfg)
  for (const p of cfg.profiles) normalizeProfileView(p)
  normalizeDisplayMeta(cfg) // 表示モデル Phase1: legacy 経路でも category 等を seed (v5Same と同一)
  for (const p of cfg.profiles) backfillPages(p.view) // glassLayout→pages[0] 投影
  pruneOrphans(cfg)
  return cfg
}

// sources に存在しない sourceId の素材 groups と全 profile view を掃除する (孤立エントリ除去)。
// 暗黙サーバの旧ランダム ID 等が孤立蓄積した不整合を、読み込み時に修復する。
function pruneOrphans(cfg: Config): void {
  const ids = new Set(cfg.sources.map((s) => s.id))
  for (const sid of Object.keys(cfg.groups)) {
    if (!ids.has(sid)) delete cfg.groups[sid]
  }
  for (const p of cfg.profiles) {
    p.enabledSourceIds = p.enabledSourceIds.filter((sid) => ids.has(sid))
    p.view.groupOrder = p.view.groupOrder.filter((r) => ids.has(r.sourceId))
    for (const sid of Object.keys(p.view.groups)) {
      if (!ids.has(sid)) delete p.view.groups[sid]
    }
    // explicit デッキ: pages[].layout の segKey が指す orphan source chip を掃除 (custom label/@right は残す)。
    // glassLayout (legacy) の rows は従来どおり掃除しない (回帰最小。render は pages を見る)。
    for (const page of p.view.pages ?? []) {
      page.layout.rows = page.layout.rows.map((row) => row.filter((k) => keepLayoutKey(k, ids)))
    }
  }
}

// layout row の key を残すか判定する。segKey (sourceId|...) は source 存在時のみ残す。
// custom label (@customLabel:) / @right / 非 segKey は常に残す。
function keepLayoutKey(key: string, sourceIds: Set<string>): boolean {
  if (!key.includes('|')) return true
  return sourceIds.has(key.split('|')[0] ?? '')
}
