import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { defaultImuConfig, type ImuConfig } from './imu'
import type { StatusDoc } from './status-types'
import { segKey, type VisibilityCond, type VisibilityLeaf } from './visibility'

// 設定 (v3): 複数データソースを横断して描画する。source は builtin(client算出) か server(URL)。
// group/segment トグルと並び順を source 名前空間付きで保持する (codex 指摘: 不変ID + structured key)。
export const CONFIG_VERSION = 3
export const BUILTIN_SOURCE_ID = 'builtin.local'

// builtin の表示ラベルはコード所有 (localStorage に保存しない)。companion はこれで
// group/segment の行名を出し、永続化された source label (旧: '本体(時刻/電池)') へ
// フォールバックしない。glass は builtins.ts の短縮ラベルを使う。
export const BUILTIN_GROUP_LABELS: Record<string, string> = {
  clock: 'Clock',
  g2: 'G2 Battery',
}
export const BUILTIN_SEG_LABELS: Record<string, string> = {
  time: 'Time',
  date: 'Date',
  level: 'Battery level',
  rate: 'Rate',
  eta: 'Estimated time left',
}

export type SourceKind = 'builtin' | 'server'
export type SourceDef = { id: string; kind: SourceKind; label: string; url?: string }
export type SegCfg = { id: string; enabled: boolean; visibility?: VisibilityCond }
export type GAlign = 'top' | 'bottom'
// align: glass summary での縦寄せ。未指定は 'top' (上から詰める従来挙動)。
export type GroupCfg = { enabled: boolean; expanded: boolean; align?: GAlign; segments: SegCfg[] }
export type GroupRef = { sourceId: string; groupId: string }

// glass の行レイアウト (表示レシピ)。group (素材) とは独立。各 row は segKey の並び。
// 未設定 (undefined) の間は従来の group=1行 自動描画。companion で「Customize layout」すると
// 現状の groupOrder から rows を生成して固定する (以降 status 増減で自動変更しない)。
export type GlassRow = { id: string; anchor: GAlign; items: string[] } // items: segKey ('src|grp|seg')
export type GlassLayout = { rows: GlassRow[] }
// IMU 方向検出は src/imu ライブラリが所有。Config は enable + キャリブの永続先として imu? を持つ。
export type Config = {
  version: number
  sources: SourceDef[]
  groups: Record<string, Record<string, GroupCfg>> // sourceId -> groupId -> cfg (nested = delimiter 衝突なし)
  groupOrder: GroupRef[] // 全ソース横断の表示順
  glassHints: boolean
  imu?: ImuConfig
  glassLayout?: GlassLayout // 未設定なら group=1行 自動描画 (deferred finalize)
}

const KEY = 'toolbar.config'

let bridge: EvenAppBridge | null = null
let memory: Config | null = null

export function setConfigBridge(b: EvenAppBridge): void {
  bridge = b
}

export function genSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// builtin local ソース (時刻/電池) を必ず先頭に持たせる。label はコード所有なので
// 既存エントリにも毎回上書きし、永続化された旧ラベル ('本体(時刻/電池)' 等) を消す。
function ensureBuiltin(cfg: Config): void {
  const existing = cfg.sources.find((s) => s.id === BUILTIN_SOURCE_ID)
  if (existing) {
    existing.kind = 'builtin'
    existing.label = 'Device' // SOURCES には出さない (companion 側で builtin を除外)。内部表示用
  } else {
    cfg.sources.unshift({ id: BUILTIN_SOURCE_ID, kind: 'builtin', label: 'Device' })
  }
  if (!cfg.groups[BUILTIN_SOURCE_ID]) cfg.groups[BUILTIN_SOURCE_ID] = {}
  migrateBuiltinGroups(cfg)
}

// 旧 builtin group 'hud' (時刻/電池を 1 group に詰めていた) を clock/g2 へ再構成する。
// segment は id が変わる (g2→level, drain→rate, est→eta) ため旧トグルは引き継がず、
// sync が status から既定 ON で補充する。builtin の表示順 (先頭) は維持する。
function migrateBuiltinGroups(cfg: Config): void {
  const bg = cfg.groups[BUILTIN_SOURCE_ID]
  if (!bg?.hud) return
  delete bg.hud
  if (!bg.clock) bg.clock = { enabled: true, expanded: false, segments: [] }
  if (!bg.g2) bg.g2 = { enabled: true, expanded: false, segments: [] }
  const idx = cfg.groupOrder.findIndex((r) => r.sourceId === BUILTIN_SOURCE_ID)
  cfg.groupOrder = cfg.groupOrder.filter((r) => r.sourceId !== BUILTIN_SOURCE_ID)
  const refs: GroupRef[] = [
    { sourceId: BUILTIN_SOURCE_ID, groupId: 'clock' },
    { sourceId: BUILTIN_SOURCE_ID, groupId: 'g2' },
  ]
  if (idx >= 0) cfg.groupOrder.splice(idx, 0, ...refs)
  else cfg.groupOrder.unshift(...refs)
}

export function emptyConfig(): Config {
  const c: Config = {
    version: CONFIG_VERSION,
    sources: [],
    groups: {},
    groupOrder: [],
    glassHints: true,
    imu: defaultImuConfig(),
  }
  ensureBuiltin(c)
  return c
}

export async function loadConfig(): Promise<Config> {
  let raw: string | null = null
  if (bridge) {
    try {
      raw = await bridge.getLocalStorage(KEY)
    } catch {
      /* fall through */
    }
  }
  if (raw) {
    try {
      return migrate(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      /* fall through */
    }
  }
  return memory ?? emptyConfig()
}

export async function saveConfig(c: Config): Promise<void> {
  memory = c
  if (bridge) {
    try {
      await bridge.setLocalStorage(KEY, JSON.stringify(c))
    } catch {
      /* bridge 不在/失敗時はメモリのみ */
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('toolbar:config-changed'))
  }
}

// v1/v2 (machines マップ) -> v3。URL・トグル・並び順を保持。builtin を先頭に追加。
type OldMachine = {
  id?: string
  label?: string
  url?: string
  sourceOrder?: string[]
  sources?: Record<string, { enabled?: boolean; expanded?: boolean; metrics?: SegCfg[] }>
}
function migrate(parsed: Record<string, unknown>): Config {
  if (parsed.version === CONFIG_VERSION) {
    const c = parsed as unknown as Config
    ensureBuiltin(c)
    c.imu ??= defaultImuConfig() // 旧 v3 config には imu が無いため default 補完
    delete (c as Record<string, unknown>).batteryRate // 旧 batteryRate 設定は廃止 (drain/est は segment 化)
    normalizeVisibilityAll(c) // 旧 single-cond 形式の visibility を複合形式へ正規化 (additive、bump 不要)
    // glassLayout は壊れていれば undefined に落とす (= 従来の group=1行 自動描画へフォールバック)
    c.glassLayout = sanitizeGlassLayout((c as Record<string, unknown>).glassLayout)
    return c
  }
  const old = parsed as {
    machines?: Record<string, OldMachine>
    glassHints?: boolean
  }
  const cfg = emptyConfig()
  cfg.glassHints = old.glassHints ?? true
  for (const [mid, mc] of Object.entries(old.machines ?? {})) {
    const id = mc.id ?? genSourceId() // v2 の不変 ID は保持、v1 は新規採番
    cfg.sources.push({ id, kind: 'server', label: mc.label ?? mid, url: mc.url })
    const groups: Record<string, GroupCfg> = {}
    for (const [gid, scfg] of Object.entries(mc.sources ?? {})) {
      groups[gid] = {
        enabled: scfg.enabled ?? true,
        expanded: scfg.expanded ?? false,
        segments: (scfg.metrics ?? []).map((m) => ({ id: m.id, enabled: m.enabled ?? true })),
      }
    }
    cfg.groups[id] = groups
    for (const gid of mc.sourceOrder ?? []) cfg.groupOrder.push({ sourceId: id, groupId: gid })
  }
  return cfg
}

// 1 leaf を sanitize する。不正なら null。threshold は op/value、onChange は holdMs を検証。
function sanitizeLeaf(x: unknown): VisibilityLeaf | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (o.kind === 'threshold' && (o.op === 'lte' || o.op === 'gte') && typeof o.value === 'number') {
    return { kind: 'threshold', op: o.op, value: o.value }
  }
  if (o.kind === 'onChange' && typeof o.holdMs === 'number') {
    return { kind: 'onChange', holdMs: o.holdMs }
  }
  return null
}

// segment の visibility を複合形式へ正規化する。新形式は leaf を sanitize、空なら undefined。
// 旧 single-cond ({kind:'always'|'threshold'|'onChange'}) は複合形式へ移行 (always=undefined)。
function normalizeVisibility(v: unknown): VisibilityCond | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (Array.isArray(o.conditions)) {
    const conditions = o.conditions.map(sanitizeLeaf).filter((l): l is VisibilityLeaf => l !== null)
    if (conditions.length === 0) return undefined
    return { combinator: o.combinator === 'or' ? 'or' : 'and', conditions }
  }
  if (o.kind === 'always') return undefined
  const leaf = sanitizeLeaf(o)
  return leaf ? { combinator: 'and', conditions: [leaf] } : undefined
}

// 全 group/segment の visibility を正規化する (同バージョン migrate から呼ぶ)。
function normalizeVisibilityAll(c: Config): void {
  for (const groups of Object.values(c.groups ?? {})) {
    for (const gcfg of Object.values(groups)) {
      for (const sc of gcfg.segments) {
        const next = normalizeVisibility(sc.visibility)
        if (next) sc.visibility = next
        else delete sc.visibility
      }
    }
  }
}

export function sourceById(cfg: Config, id: string): SourceDef | undefined {
  return cfg.sources.find((s) => s.id === id)
}

// glass layout を現在の groupOrder + align + enabled segment から生成する (カスタマイズ開始時の初期値)。
// 1 group = 1 row (anchor は group.align)。enabled segment が無い group は row を作らない。
export function generateGlassLayout(cfg: Config): GlassLayout {
  const rows: GlassRow[] = []
  for (const ref of cfg.groupOrder) {
    const gc = cfg.groups[ref.sourceId]?.[ref.groupId]
    if (!gc?.enabled) continue
    const items = gc.segments
      .filter((s) => s.enabled)
      .map((s) => segKey(ref.sourceId, ref.groupId, s.id))
    if (items.length) rows.push({ id: genSourceId(), anchor: gc.align ?? 'top', items })
  }
  return { rows }
}

// 永続化された glassLayout を検証する。壊れていれば undefined (= 自動描画にフォールバック)。
function sanitizeGlassLayout(x: unknown): GlassLayout | undefined {
  if (!x || typeof x !== 'object') return undefined
  const rows = (x as { rows?: unknown }).rows
  if (!Array.isArray(rows)) return undefined
  const out: GlassRow[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const rr = r as { id?: unknown; anchor?: unknown; items?: unknown }
    if (!Array.isArray(rr.items)) continue
    const items = rr.items.filter((s): s is string => typeof s === 'string')
    out.push({
      id: typeof rr.id === 'string' ? rr.id : genSourceId(),
      anchor: rr.anchor === 'bottom' ? 'bottom' : 'top',
      items,
    })
  }
  return { rows: out }
}

// 新規 server ソースを不変 ID で追加する。
export function addServer(cfg: Config, label: string, url?: string): SourceDef {
  const def: SourceDef = { id: genSourceId(), kind: 'server', label, url }
  cfg.sources.push(def)
  cfg.groups[def.id] = {}
  return def
}

// ソースを削除する (builtin は不可)。group 設定と groupOrder も掃除する。
export function removeSource(cfg: Config, id: string): void {
  if (id === BUILTIN_SOURCE_ID) return
  cfg.sources = cfg.sources.filter((s) => s.id !== id)
  delete cfg.groups[id]
  cfg.groupOrder = cfg.groupOrder.filter((r) => r.sourceId !== id)
}

// status を該当ソースの設定に反映する。新規 group/segment は既定追加 + groupOrder 末尾へ。
// 既存トグル・並び順は保持。追加があれば true。
export function syncSourceWithStatus(cfg: Config, sourceId: string, status: StatusDoc): boolean {
  let changed = false
  if (!cfg.groups[sourceId]) cfg.groups[sourceId] = {}
  const groups = cfg.groups[sourceId]
  for (const g of status.groups) {
    let gc = groups[g.id]
    if (!gc) {
      gc = { enabled: true, expanded: false, segments: [] }
      groups[g.id] = gc
      cfg.groupOrder.push({ sourceId, groupId: g.id })
      changed = true
    }
    for (const seg of g.segments) {
      if (!gc.segments.some((s) => s.id === seg.id)) {
        gc.segments.push({ id: seg.id, enabled: seg.defaultEnabled ?? true })
        changed = true
      }
    }
  }
  return changed
}
