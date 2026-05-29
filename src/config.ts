import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { MAX_ROWS } from './glass-render'
import { defaultImuConfig, type ImuConfig } from './imu'
import type { StatusDoc } from './status-types'
import { segKey, type VisibilityCond, type VisibilityLeaf } from './visibility'

// 設定 (v4): 素材 (sources / groups) とレシピ (profiles) の 2 層構成。
// 素材 = 接続先と metric の素性 (存在・format・閾値条件) を状況に依らず 1 つだけ持つ。
// レシピ = profile.view が「何を出すか・どう並べるか・10 行にどう置くか」を状況ごとに持つ。
// Phase 1 (MVP) は Default profile 1 個 (id 'default') に v3 の全構成を収容し activeProfileId 固定。
export const CONFIG_VERSION = 4
export const BUILTIN_SOURCE_ID = 'builtin.local'
// 暗黙の既定サーバ (同一オリジン) の決定的 ID。起動毎にランダム ID で再追加すると groupOrder が
// 孤立蓄積するため、固定 ID にして二重 init / 再起動でも同一ソースに収束させる。
export const LOCAL_SOURCE_ID = 'server.local'
export const DEFAULT_PROFILE_ID = 'default'

// glass layout の「ラベル chip」を表す予約 segId。items の key が `src|grp|@label` のとき、
// その group のラベルテキスト (Claude 等) を glass に出す (自動接頭辞は廃止、配置式)。
export const LABEL_SEG = '@label'

// ユーザー定義の自由テキストラベル。rows には key `@customLabel:<id>` だけを置き、本文は
// glassLayout.customLabels[id].text に持つ (key にテキストを入れない = '|' 衝突回避)。
export const CUSTOM_LABEL_PREFIX = '@customLabel:'
export function customLabelKey(id: string): string {
  return CUSTOM_LABEL_PREFIX + id
}
export function isCustomLabelKey(key: string): boolean {
  return key.startsWith(CUSTOM_LABEL_PREFIX)
}
export function customLabelId(key: string): string {
  return key.slice(CUSTOM_LABEL_PREFIX.length)
}
export function genLabelId(): string {
  return `cl_${genSourceId().slice(0, 8)}`
}

// 行内の左右クラスタ区切り (iOS ステータスバー型)。rows[i] にこの予約キーを 1 つ置くと
// その前 = 左寄せ / 後 = 右寄せ。無ければ全て左寄せ (従来挙動・後方互換)。実機は
// justify-between (pretext で px 計測し中央を space 充填)、companion は flex space-between。
// segKey ('|' 区切り) とも customLabelKey ('@customLabel:' 前置) とも衝突しない。
export const RIGHT_DIVIDER = '@right'
export function isRightDivider(key: string): boolean {
  return key === RIGHT_DIVIDER
}

// builtin の表示ラベルはコード所有 (localStorage に保存しない)。companion はこれで
// group/segment の行名を出し、永続化された source label (旧: '本体(時刻/電池)') へ
// フォールバックしない。glass は builtins.ts の短縮ラベルを使う。
export const BUILTIN_GROUP_LABELS: Record<string, string> = {
  clock: 'Clock',
  g2: 'G2', // segment 'Bat' と重複しないよう短縮 ("G2 Bat 82%")
}
export const BUILTIN_SEG_LABELS: Record<string, string> = {
  time: 'Time',
  date: 'Date',
  datetime: 'Date & Time',
  level: 'Battery level',
  rate: 'Rate',
  eta: 'Estimated time left',
}

export type SourceKind = 'builtin' | 'server'
// urls: 複数経路 (LAN / VPN 等。到達順に試行、先頭優先)。MVP では urls を正とし、旧 url? は
//   後方互換で読み migrate で urls[0] へ正規化する。machineId: 同一マシン判定キー (Phase 3 で採用)。
export type SourceDef = {
  id: string
  kind: SourceKind
  label: string
  url?: string // 後方互換 (読込専用)。新規書込は urls を使う
  urls: string[]
  machineId?: string
}

// ── 素材 (共有資産) ──
// metric の素性のみを持つ。format: clock segment の表示フォーマット (例 'HH:mm')、未設定はロケール既定。
// visibility: 閾値/onChange 表示条件。表示系 (enabled/align 等) は profile.view へ分離する。
export type SegMeta = { id: string; format?: string; visibility?: VisibilityCond }
export type GroupMeta = { segments: SegMeta[] }

export type GAlign = 'top' | 'bottom'
export type GroupRef = { sourceId: string; groupId: string }

// ── レシピ (profile 固有) ──
// ViewGroup: profile ごとの可視性・展開・寄せ・group ラベル前置と segment 可視性 (segId -> boolean)。
// align: glass summary での縦寄せ。未指定は 'top'。
// showDefaultLabel: glass で各 segment の前に group ラベル (G2/Claude 等) を出すか (未指定 clock=false/他=true)。
export type ViewGroup = {
  enabled: boolean
  expanded?: boolean
  align?: GAlign
  showDefaultLabel?: boolean
  segments: Record<string, boolean>
}

// glass の行レイアウト (表示レシピ)。group (素材) とは独立した固定 MAX_ROWS 行スロット。
// rows[i] = i 行目の segKey 並び (空行可)。どの行にも無い enabled segment は companion の
// Unplaced 棚に自動表示。未設定 (undefined) の間は従来の group=1行 自動描画。
export type GlassLayout = {
  rows: string[][] // rows.length === MAX_ROWS。各要素 = key (segKey / @label / @customLabel:id)
  customLabels: Record<string, { text: string }> // ユーザー定義ラベルの本文 (id -> text)
}

// profile の view (レシピ)。可視性・並び・10 行配置を状況ごとに持つ。
export type ProfileView = {
  groups: Record<string, Record<string, ViewGroup>> // sourceId -> groupId -> ViewGroup
  groupOrder: GroupRef[] // 全ソース横断の表示順
  glassLayout?: GlassLayout // 未設定なら group=1行 自動描画
}

// profile = 状況セット。enabledSourceIds は fetch/表示する source の範囲。
export type Profile = {
  id: string
  name: string
  enabledSourceIds: string[]
  view: ProfileView
}

// IMU 方向検出は src/imu ライブラリが所有。Config は enable + キャリブの永続先として imu? を持つ。
export type Config = {
  version: number
  sources: SourceDef[]
  groups: Record<string, Record<string, GroupMeta>> // sourceId -> groupId -> 素材 (segment 素性のみ)
  profiles: Profile[]
  activeProfileId: string
  imu?: ImuConfig
}

const KEY = 'toolbar.config'

let bridge: EvenAppBridge | null = null
let memory: Config | null = null
// bridge への保存を直列化するチェイン。companion が連続トグルで await を外しても、
// 各タスクが最新 memory を書く + 書込み完了後に通知することで、古い JSON での上書きを防ぐ。
let saveChain: Promise<void> = Promise.resolve()

export function setConfigBridge(b: EvenAppBridge): void {
  bridge = b
}

export function genSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function genProfileId(): string {
  return `prof_${genSourceId().slice(0, 8)}`
}

// group の default-label 既定値: builtin clock のみ OFF (時刻に 'Clock' は不要)、他は ON。
export function defaultShowGroupLabel(groupId: string): boolean {
  return groupId !== 'clock'
}

// ── profile アクセサ ──
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

// active profile の enabledSourceIds に含まれる source (builtin 含む) だけを返す (fetch 範囲)。
// store はこれを fetch 対象にする。MVP は Default=全 source なので結果は cfg.sources と同じ。
export function enabledSources(cfg: Config): SourceDef[] {
  const enabled = new Set(activeProfile(cfg).enabledSourceIds)
  return cfg.sources.filter((s) => s.id === BUILTIN_SOURCE_ID || enabled.has(s.id))
}

// source の主 URL (urls 先頭、無ければ後方互換 url)。fetch / 鮮度 diff に使う。
export function sourceUrl(s: SourceDef): string | undefined {
  return s.urls?.[0] ?? s.url
}

function emptyProfileView(): ProfileView {
  return { groups: {}, groupOrder: [] }
}

function emptyDefaultProfile(): Profile {
  return { id: DEFAULT_PROFILE_ID, name: 'Default', enabledSourceIds: [], view: emptyProfileView() }
}

// builtin local ソース (時刻/電池) を必ず先頭に持たせる。label はコード所有なので
// 既存エントリにも毎回上書きし、永続化された旧ラベル ('本体(時刻/電池)' 等) を消す。
function ensureBuiltin(cfg: Config): void {
  const existing = cfg.sources.find((s) => s.id === BUILTIN_SOURCE_ID)
  if (existing) {
    existing.kind = 'builtin'
    existing.label = 'Device' // SOURCES には出さない (companion 側で builtin を除外)。内部表示用
    existing.urls ??= []
  } else {
    cfg.sources.unshift({ id: BUILTIN_SOURCE_ID, kind: 'builtin', label: 'Device', urls: [] })
  }
  if (!cfg.groups[BUILTIN_SOURCE_ID]) cfg.groups[BUILTIN_SOURCE_ID] = {}
  // builtin は全 profile の enabledSourceIds に必ず含める (fetch 範囲に builtin を残す)。
  for (const p of cfg.profiles) {
    if (!p.enabledSourceIds.includes(BUILTIN_SOURCE_ID))
      p.enabledSourceIds.unshift(BUILTIN_SOURCE_ID)
  }
  migrateBuiltinGroups(cfg)
}

// 旧 builtin group 'hud' (時刻/電池を 1 group に詰めていた) を clock/g2 へ再構成する。
// segment は id が変わる (g2→level, drain→rate, est→eta) ため旧トグルは引き継がず、
// sync が status から既定 ON で補充する。builtin の表示順 (先頭) は維持する。
function migrateBuiltinGroups(cfg: Config): void {
  const bg = cfg.groups[BUILTIN_SOURCE_ID]
  if (!bg?.hud) return
  delete bg.hud
  if (!bg.clock) bg.clock = { segments: [] }
  if (!bg.g2) bg.g2 = { segments: [] }
  const view = activeView(cfg)
  view.groups[BUILTIN_SOURCE_ID] ??= {}
  view.groups[BUILTIN_SOURCE_ID].clock ??= { enabled: true, showDefaultLabel: false, segments: {} }
  view.groups[BUILTIN_SOURCE_ID].g2 ??= { enabled: true, showDefaultLabel: true, segments: {} }
  const idx = view.groupOrder.findIndex((r) => r.sourceId === BUILTIN_SOURCE_ID)
  view.groupOrder = view.groupOrder.filter((r) => r.sourceId !== BUILTIN_SOURCE_ID)
  const refs: GroupRef[] = [
    { sourceId: BUILTIN_SOURCE_ID, groupId: 'clock' },
    { sourceId: BUILTIN_SOURCE_ID, groupId: 'g2' },
  ]
  if (idx >= 0) view.groupOrder.splice(idx, 0, ...refs)
  else view.groupOrder.unshift(...refs)
}

export function emptyConfig(): Config {
  const c: Config = {
    version: CONFIG_VERSION,
    sources: [],
    groups: {},
    profiles: [emptyDefaultProfile()],
    activeProfileId: DEFAULT_PROFILE_ID,
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
  if (!bridge) {
    // bridge 不在 (ブラウザ dev / 未接続): メモリのみ。glass/companion へ即時通知。
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toolbar:config-changed'))
    }
    return
  }
  // 書込みを直列化し、各タスクは最新 memory を書く (古い JSON での上書き防止)。
  // config-changed は書込み完了後に発火する。発火を書込み前に出すと glass の loadConfig が
  // bridge から stale を読むため (glass.ts onConfigChanged は getLocalStorage で再読込する)。
  saveChain = saveChain.then(async () => {
    try {
      await bridge?.setLocalStorage(KEY, JSON.stringify(memory))
    } catch {
      /* bridge 失敗時はメモリのみ */
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toolbar:config-changed'))
    }
  })
  return saveChain
}

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

function migrate(parsed: Record<string, unknown>): Config {
  if (parsed.version === CONFIG_VERSION) return migrateV4Same(parsed as unknown as Config)
  if (parsed.version === 3) return migrateV3ToV4(parsed as unknown as V3Config)
  return migrateLegacyToV4(parsed)
}

// v4 同バージョン: additive 正規化を流す (素材/profile 構造は既に整っている前提)。
function migrateV4Same(c: Config): Config {
  c.profiles ??= []
  if (!c.profiles.length) c.profiles.push(emptyDefaultProfile())
  c.activeProfileId ??= c.profiles[0]?.id ?? DEFAULT_PROFILE_ID
  c.groups ??= {}
  c.sources ??= []
  for (const s of c.sources) normalizeSourceUrls(s)
  ensureBuiltin(c)
  c.imu ??= defaultImuConfig()
  delete (c as Record<string, unknown>).batteryRate
  delete (c as Record<string, unknown>).glassHints
  normalizeMetaVisibilityAll(c) // 素材 segment の visibility を複合形式へ正規化
  for (const p of c.profiles) normalizeProfileView(p)
  consolidateClock(c)
  pruneOrphans(c)
  return c
}

// v3 (素材と表示が混在・単一構成) -> v4。全構成を Default profile の view + enabledSourceIds へ収容する。
type V3Config = {
  version: number
  sources?: Array<{ id: string; kind: SourceKind; label: string; url?: string }>
  groups?: Record<string, Record<string, OldGroupCfg>>
  groupOrder?: GroupRef[]
  glassLayout?: unknown
  imu?: ImuConfig
}
function migrateV3ToV4(old: V3Config): Config {
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
  // 全 source を Default の enabledSourceIds に含める (見た目不変 = v3 は全集約)。
  def.enabledSourceIds = cfg.sources.map((s) => s.id)
  // builtin が先頭に来るよう ensureBuiltin を再適用 (順序 + enabledSourceIds)。
  ensureBuiltin(cfg)
  normalizeMetaVisibilityAll(cfg)
  for (const p of cfg.profiles) normalizeProfileView(p)
  consolidateClock(cfg)
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

// v1/v2 (machines マップ) -> v4。素材 + Default profile view を直接構築する。
function migrateLegacyToV4(parsed: Record<string, unknown>): Config {
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
  def.enabledSourceIds = cfg.sources.map((s) => s.id)
  ensureBuiltin(cfg)
  normalizeMetaVisibilityAll(cfg)
  for (const p of cfg.profiles) normalizeProfileView(p)
  pruneOrphans(cfg)
  return cfg
}

// 旧 url? を urls[0] へ正規化する (urls 不在なら url から、両方あれば url を先頭に補完)。
function normalizeSourceUrls(s: SourceDef): void {
  if (!Array.isArray(s.urls)) s.urls = []
  if (s.url && !s.urls.includes(s.url)) s.urls.unshift(s.url)
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

// 素材側 segment の visibility を正規化する (素材は profile 非依存)。
function normalizeMetaVisibilityAll(c: Config): void {
  for (const groups of Object.values(c.groups ?? {})) {
    for (const meta of Object.values(groups)) {
      for (const sm of meta.segments) {
        const next = normalizeVisibility(sm.visibility)
        if (next) sm.visibility = next
        else delete sm.visibility
      }
    }
  }
}

// profile.view の glassLayout / groupOrder / ViewGroup を正規化する (additive)。
function normalizeProfileView(p: Profile): void {
  p.view ??= emptyProfileView()
  p.view.groups ??= {}
  if (!Array.isArray(p.view.groupOrder)) p.view.groupOrder = []
  p.view.glassLayout = normalizeGlassLayout(p.view.glassLayout)
  for (const [, groups] of Object.entries(p.view.groups)) {
    for (const [gid, vg] of Object.entries(groups)) {
      vg.segments ??= {}
      vg.showDefaultLabel ??= defaultShowGroupLabel(gid)
    }
  }
}

export function sourceById(cfg: Config, id: string): SourceDef | undefined {
  return cfg.sources.find((s) => s.id === id)
}

function emptyRows(): string[][] {
  return Array.from({ length: MAX_ROWS }, () => [])
}

// glass layout を active profile の groupOrder + enabled segment から生成する (Customize 時の初期値)。
// 1 group = 1 行を上から詰める。MAX_ROWS を超えた分は配置せず Unplaced 棚 (導出) に出る。
export function generateGlassLayout(cfg: Config): GlassLayout {
  const view = activeView(cfg)
  const rows = emptyRows()
  let i = 0
  for (const ref of view.groupOrder) {
    const vg = view.groups[ref.sourceId]?.[ref.groupId]
    const meta = cfg.groups[ref.sourceId]?.[ref.groupId]
    if (!vg?.enabled || !meta) continue
    const items = meta.segments
      .filter((s) => vg.segments[s.id] ?? true)
      .map((s) => segKey(ref.sourceId, ref.groupId, s.id))
    if (items.length && i < MAX_ROWS) rows[i++] = items
  }
  return { rows, customLabels: {} }
}

// 永続化された customLabels を検証する (id -> {text})。text 文字列のみ採用。
function sanitizeCustomLabels(x: unknown): Record<string, { text: string }> {
  const out: Record<string, { text: string }> = {}
  if (x && typeof x === 'object') {
    for (const [id, v] of Object.entries(x as Record<string, unknown>)) {
      const t = (v as { text?: unknown })?.text
      if (typeof t === 'string') out[id] = { text: t }
    }
  }
  return out
}

// 永続化された glassLayout を新形式 (固定 MAX_ROWS 行) に正規化する。
// 旧 anchor 形式 ({rows:[{anchor,items}]}) は絶対行へ移行 (top は上から / bottom は下から)。
// 壊れていれば undefined (= 自動描画にフォールバック)。
function normalizeGlassLayout(x: unknown): GlassLayout | undefined {
  if (!x || typeof x !== 'object') return undefined
  const rowsRaw = (x as { rows?: unknown }).rows
  if (!Array.isArray(rowsRaw)) return undefined
  // 旧 @label 配置 chip は廃止 (default-label が自動で group 名を出す) → rows から除去。
  const strList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === 'string' && !s.endsWith(`|${LABEL_SEG}`))
      : []
  const customLabels = sanitizeCustomLabels((x as { customLabels?: unknown }).customLabels)
  // 行内の @right は 1 個のみ有効 (最初を残し残りを除去)。前=左 / 後=右クラスタの区切り。
  const onceDivider = (row: string[]): string[] => {
    let seen = false
    return row.filter((k) => {
      if (!isRightDivider(k)) return true
      if (seen) return false
      seen = true
      return true
    })
  }
  // 新形式: rows が string[][]
  if (rowsRaw.every((r) => Array.isArray(r))) {
    const rows = emptyRows()
    for (let i = 0; i < MAX_ROWS; i++) rows[i] = onceDivider(strList(rowsRaw[i]))
    return { rows, customLabels }
  }
  // 旧 anchor 形式 → 絶対行 (top は上から / bottom は下から詰める)
  const top: string[][] = []
  const bottom: string[][] = []
  for (const r of rowsRaw) {
    if (!r || typeof r !== 'object') continue
    const rr = r as { anchor?: unknown; items?: unknown }
    const items = strList(rr.items)
    if (!items.length) continue
    ;(rr.anchor === 'bottom' ? bottom : top).push(items)
  }
  const rows = emptyRows()
  let i = 0
  for (const r of top) if (i < MAX_ROWS) rows[i++] = r
  let j = MAX_ROWS - 1
  for (let k = bottom.length - 1; k >= 0 && j >= i; k--) rows[j--] = bottom[k]
  return { rows, customLabels }
}

// clock を単一 datetime segment に統合する (旧 time/date を廃止)。同バージョン additive 移行:
// 素材 SegMeta から time/date を除去し datetime を確保、active view の segment 可視性と
// glassLayout の旧キーを datetime へ remap する (重複は 1 つに)。
function consolidateClock(c: Config): void {
  const clock = c.groups[BUILTIN_SOURCE_ID]?.clock
  const view = activeView(c)
  const vg = view.groups[BUILTIN_SOURCE_ID]?.clock
  if (clock) {
    const timeSeg = clock.segments.find((s) => s.id === 'time')
    const dateSeg = clock.segments.find((s) => s.id === 'date')
    const dt = clock.segments.find((s) => s.id === 'datetime')
    if (!dt) {
      // 旧 time/date を 1 つの datetime に統合: format を合成 (区切り 2 スペース)。
      const fmt = [timeSeg?.format ?? '', dateSeg?.format ?? ''].filter(Boolean).join('  ')
      const sm: SegMeta = { id: 'datetime' }
      if (fmt) sm.format = fmt
      clock.segments.push(sm)
      if (vg) {
        const tEn = vg.segments.time
        const dEn = vg.segments.date
        vg.segments.datetime ??= tEn != null || dEn != null ? !!(tEn || dEn) : true
      }
    }
    // 既存 datetime は format をそのまま保持 (上書きしない)
    clock.segments = clock.segments.filter((s) => s.id !== 'time' && s.id !== 'date')
  }
  if (vg) {
    delete vg.segments.time
    delete vg.segments.date
  }
  const lay = view.glassLayout
  if (!lay) return
  const oldKeys = new Set([`${BUILTIN_SOURCE_ID}|clock|time`, `${BUILTIN_SOURCE_ID}|clock|date`])
  const dtKey = `${BUILTIN_SOURCE_ID}|clock|datetime`
  let seen = false // datetime は 1 箇所のみ (旧 time/date が別行にあっても先頭へ集約)
  lay.rows = lay.rows.map((row) =>
    row.flatMap((k) => {
      if (oldKeys.has(k) || k === dtKey) {
        if (seen) return []
        seen = true
        return [dtKey]
      }
      return [k]
    }),
  )
}

// 新規 server ソースを不変 ID で追加する (ユーザー追加。ランダム ID)。
// 素材 groups と active profile の enabledSourceIds + view 枠を確保する。
export function addServer(cfg: Config, label: string, url?: string): SourceDef {
  const def: SourceDef = { id: genSourceId(), kind: 'server', label, urls: url ? [url] : [] }
  if (url) def.url = url
  cfg.sources.push(def)
  cfg.groups[def.id] = {}
  const prof = activeProfile(cfg)
  if (!prof.enabledSourceIds.includes(def.id)) prof.enabledSourceIds.push(def.id)
  prof.view.groups[def.id] ??= {}
  return def
}

// 暗黙の既定サーバ (同一オリジン) を決定的 ID で保証する。server が 1 つも無いときだけ追加する。
// addServer (ランダム ID) と違い固定 ID なので、bridge 準備前後の二重 init や再起動で再追加されても
// 同一ソースに収束し、view が孤立蓄積しない。追加したら true。
export function ensureDefaultServer(cfg: Config, url: string): boolean {
  if (cfg.sources.some((s) => s.kind === 'server')) return false
  cfg.sources.push({ id: LOCAL_SOURCE_ID, kind: 'server', label: 'Local', url, urls: [url] })
  cfg.groups[LOCAL_SOURCE_ID] ??= {}
  const prof = activeProfile(cfg)
  if (!prof.enabledSourceIds.includes(LOCAL_SOURCE_ID)) prof.enabledSourceIds.push(LOCAL_SOURCE_ID)
  prof.view.groups[LOCAL_SOURCE_ID] ??= {}
  return true
}

// ソースを削除する (builtin は不可)。素材 groups と全 profile の view + enabledSourceIds も掃除する。
export function removeSource(cfg: Config, id: string): void {
  if (id === BUILTIN_SOURCE_ID) return
  cfg.sources = cfg.sources.filter((s) => s.id !== id)
  delete cfg.groups[id]
  for (const p of cfg.profiles) {
    p.enabledSourceIds = p.enabledSourceIds.filter((sid) => sid !== id)
    delete p.view.groups[id]
    p.view.groupOrder = p.view.groupOrder.filter((r) => r.sourceId !== id)
  }
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
  }
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
    let vg = vgroups[g.id]
    if (!vg) {
      vg = { enabled: true, showDefaultLabel: defaultShowGroupLabel(g.id), segments: {} }
      vgroups[g.id] = vg
      view.groupOrder.push({ sourceId, groupId: g.id })
      changed = true
    }
    for (const seg of g.segments) {
      if (!gm.segments.some((s) => s.id === seg.id)) {
        gm.segments.push({ id: seg.id })
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
