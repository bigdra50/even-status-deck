import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { MAX_ROWS } from './glass-types'
import { defaultImuConfig, type ImuConfig } from './imu'
import type { StatusDoc } from './status-types'
import { segKey, type VisibilityCond, type VisibilityLeaf } from './visibility/keys'

// 設定 (v4): 素材 (sources / groups) とレシピ (profiles) の 2 層構成。
// 素材 = 接続先と metric の素性 (存在・format・閾値条件) を状況に依らず 1 つだけ持つ。
// レシピ = profile.view が「何を出すか・どう並べるか・10 行にどう置くか」を状況ごとに持つ。
// Phase 1 (MVP) は Default profile 1 個 (id 'default') に v3 の全構成を収容し activeProfileId 固定。
export const CONFIG_VERSION = 4
export const BUILTIN_SOURCE_ID = 'builtin.local'
// 暗黙の既定サーバ (同一オリジン) の決定的 ID。起動毎にランダム ID で再追加すると groupOrder が
// 孤立蓄積するため、固定 ID にして二重 init / 再起動でも同一ソースに収束させる。
export const LOCAL_SOURCE_ID = 'server.local'
// 気象 client source の決定的 ID。位置は companion WebView の geolocation で取る(SDK に GPS 無し)。
export const WEATHER_SOURCE_ID = 'client.weather'
// 標高/タイムゾーン client source の決定的 ID (#45)。weather と同じ geolocation を使う別 source。
export const GEOINFO_SOURCE_ID = 'client.geoinfo'
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

export type SourceKind = 'builtin' | 'server' | 'client'
// 表示オプション値のバッグ (#36)。キー = OptionField.id、値はプリミティブのみ。
// 宣言 (OptionField) と解決/書込ロジックは src/options.ts が所有する。config はここに永続型だけ置き、
// options.ts を import しない (config ↔ options の循環依存を作らない)。
export type OptionValues = Record<string, string | number | boolean>
// urls: 複数経路 (LAN / VPN 等。到達順に試行、先頭優先)。MVP では urls を正とし、旧 url? は
//   後方互換で読み migrate で urls[0] へ正規化する。machineId: 同一マシン判定キー (Phase 3 で採用)。
// options: source 単位の表示オプション (単位/粒度 等。素材 = 全 profile 共有)。
export type SourceDef = {
  id: string
  kind: SourceKind
  label: string
  url?: string // 後方互換 (読込専用)。新規書込は urls を使う
  urls: string[]
  machineId?: string
  options?: OptionValues
}

// ── 素材 (共有資産) ──
// metric の素性のみを持つ。format: clock segment の表示フォーマット (例 'HH:mm')、未設定はロケール既定。
// visibility: 閾値/onChange 表示条件。表示系 (enabled/align 等) は profile.view へ分離する。
// options: segment 単位の表示オプション (#36。clock は後方互換で format に合成するため options を使わない)。
export type SegMeta = {
  id: string
  format?: string
  options?: OptionValues
  visibility?: VisibilityCond
}
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

// 削除した source の表示レシピ snapshot (machineId 別)。Phase 3: 同一マシン再追加で
// profile の可視性/並び/glassLayout を復元する tombstone。profileId -> その profile の view 断片 + enabled。
// machineId をキーにし sourceId はキーにしない (id 生成規則を将来変えても復元できる)。
export type RemovedSourceView = {
  enabled: boolean // 削除前に enabledSourceIds に含まれていたか (fetch 範囲の復元)
  groups: Record<string, ViewGroup> // groupId -> ViewGroup (可視性/展開/寄せ/segment 可視性)
  groupRefs: string[] // groupOrder に含まれていた groupId 群 (順序復元用)
  glassRows: Record<string, string[][]> | null // 旧 sourceId|grp|seg を含む glass 行 (再 key 用に旧 sourceId も保持)
}
export type RemovedView = {
  at: number // 削除時刻 (古い tombstone を間引く)
  oldSourceId: string // 削除時の id (glass row の旧 segKey を新 id へ remap する用)
  profiles: Record<string, RemovedSourceView> // profileId -> view 断片
}

// IMU 方向検出は src/imu ライブラリが所有。Config は enable + キャリブの永続先として imu? を持つ。
// recentlyRemoved: 削除済み source の表示レシピ tombstone (machineId -> snapshot)。additive optional。
export type Config = {
  version: number
  sources: SourceDef[]
  groups: Record<string, Record<string, GroupMeta>> // sourceId -> groupId -> 素材 (segment 素性のみ)
  profiles: Profile[]
  activeProfileId: string
  imu?: ImuConfig
  recentlyRemoved?: Record<string, RemovedView>
}

// tombstone の保持上限 (古いものから間引く)。無制限に溜めない。
const MAX_REMOVED_VIEWS = 16

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

// machineId 派生の source id。hostname ベースの安定 ID を id 名前空間へ正規化する
// (英数とハイフンのみ・小文字)。これにより削除→同一マシン再追加で同じ id に収束する。
function deriveSourceId(machineId: string): string {
  const norm = machineId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return norm ? `host-${norm}` : ''
}

// 衝突時 (同一 hostname の別マシン等) の disambiguation。machineId 派生 id に url の
// 短縮 hash を足して別ソース化する。url が無ければ短いランダム接尾辞で代替する。
function urlHash(url: string): string {
  let h = 2166136261 >>> 0 // FNV-1a 32bit
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36).slice(0, 6)
}
function disambiguateSourceId(base: string, url?: string): string {
  const suffix = url ? urlHash(url) : genSourceId().slice(0, 6)
  return `${base}-${suffix}`
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

// source の主 URL (urls 先頭、無ければ後方互換 url)。鮮度 diff / 表示に使う。
export function sourceUrl(s: SourceDef): string | undefined {
  return s.urls?.[0] ?? s.url
}

// source の全経路 (到達順)。urls を正とし、後方互換 url が漏れていれば末尾に補う。
// store の failover fetch はこの順に試す (先頭優先・失敗で次)。
export function sourceUrls(s: SourceDef): string[] {
  const list = Array.isArray(s.urls) ? [...s.urls] : []
  if (s.url && !list.includes(s.url)) list.push(s.url)
  return list
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

// 気象 client source (現在地ベース)。SDK に GPS が無いため位置は companion WebView の
// geolocation で取得する。既定は無効 (opt-in): enabledSourceIds に入れず、ユーザーが
// "Add source" で有効化したとき初めて位置許可を求める。素材 group は status sync が補充する。
function ensureClientWeather(cfg: Config): void {
  const existing = cfg.sources.find((s) => s.id === WEATHER_SOURCE_ID)
  if (existing) {
    existing.kind = 'client'
    existing.label = 'Weather'
    existing.urls ??= []
  } else {
    cfg.sources.push({ id: WEATHER_SOURCE_ID, kind: 'client', label: 'Weather', urls: [] })
  }
  cfg.groups[WEATHER_SOURCE_ID] ??= {}
}

// 標高/タイムゾーン client source (#45)。weather と同様に既定無効(opt-in)。素材 group は status sync が補充する。
function ensureClientGeoinfo(cfg: Config): void {
  const existing = cfg.sources.find((s) => s.id === GEOINFO_SOURCE_ID)
  if (existing) {
    existing.kind = 'client'
    existing.label = 'Location'
    existing.urls ??= []
  } else {
    cfg.sources.push({ id: GEOINFO_SOURCE_ID, kind: 'client', label: 'Location', urls: [] })
  }
  cfg.groups[GEOINFO_SOURCE_ID] ??= {}
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
  ensureClientWeather(c)
  ensureClientGeoinfo(c)
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

// 任意 version の生 config を v4 へ移行する。export は単体テスト用(loadConfig は bridge 依存で叩けない)。
export function migrate(parsed: Record<string, unknown>): Config {
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
  ensureClientWeather(c)
  ensureClientGeoinfo(c)
  c.imu ??= defaultImuConfig()
  delete (c as Record<string, unknown>).batteryRate
  delete (c as Record<string, unknown>).glassHints
  normalizeMetaVisibilityAll(c) // 素材 segment の visibility を複合形式へ正規化
  normalizeOptionsAll(c) // 素材 segment / source の表示オプションを sanitize (#36)
  for (const p of c.profiles) normalizeProfileView(p)
  migrateMacGroupToSystem(c) // OD-1: server source の system provider group id 'mac' → 'system'
  consolidateClock(c)
  normalizeRemovedViews(c) // tombstone を間引き (壊れていれば破棄)
  pruneOrphans(c)
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

// 永続化された recentlyRemoved を検証・間引く。壊れた entry は破棄し、件数上限を超えたら古い順に削る。
function normalizeRemovedViews(c: Config): void {
  const rv = c.recentlyRemoved
  if (!rv || typeof rv !== 'object') {
    delete c.recentlyRemoved
    return
  }
  for (const [mid, view] of Object.entries(rv)) {
    if (!view || typeof view !== 'object' || typeof view.oldSourceId !== 'string') delete rv[mid]
  }
  if (!Object.keys(rv).length) delete c.recentlyRemoved
  else pruneRemovedViews(c)
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
  // 旧 source を Default の enabledSourceIds に集約する(v3 の見た目を維持)。ただし client source
  // (weather/geoinfo 等)は opt-in なので既定 ON にしない(さもないと旧 config の升級で位置許可/外部 fetch が走る)。
  def.enabledSourceIds = cfg.sources.filter((s) => s.kind !== 'client').map((s) => s.id)
  // builtin が先頭に来るよう ensureBuiltin を再適用 (順序 + enabledSourceIds)。
  ensureBuiltin(cfg)
  ensureClientWeather(cfg)
  ensureClientGeoinfo(cfg)
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
  // client source(weather/geoinfo 等)は opt-in なので既定 ON にしない。移行で見た目を変えない対象は
  // builtin + 旧ユーザー source(server)のみ。さもないと旧 config の升級で位置許可/外部 fetch が走る。
  def.enabledSourceIds = cfg.sources.filter((s) => s.kind !== 'client').map((s) => s.id)
  ensureBuiltin(cfg)
  ensureClientWeather(cfg)
  ensureClientGeoinfo(cfg)
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

// options バッグを構造的に sanitize する (#36)。プリミティブ (string/number/boolean) 以外の値を落とし、
// 空なら undefined を返す。未知キー除去・default 適用・clamp は読み取り時 (options.ts の resolveX) が行う
// ため、ここでは型不正値の除去だけに留める (config は options.ts を import しない)。
function normalizeOptionsBag(bag: unknown): OptionValues | undefined {
  if (!bag || typeof bag !== 'object') return undefined
  const out: OptionValues = {}
  for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

// 全 source / 素材 segment の options バッグを sanitize する (壊れた options でクラッシュさせない)。
function normalizeOptionsAll(c: Config): void {
  for (const s of c.sources) {
    const next = normalizeOptionsBag(s.options)
    if (next) s.options = next
    else delete s.options
  }
  for (const groups of Object.values(c.groups ?? {})) {
    for (const meta of Object.values(groups)) {
      for (const sm of meta.segments) {
        const next = normalizeOptionsBag(sm.options)
        if (next) sm.options = next
        else delete sm.options
      }
    }
  }
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
  // groupOrder は (sourceId,groupId) で一意。machineId remap や旧バージョン移行で混入した
  // 重複を除去する (重複すると同じ group が Items / glass に二重表示される)。最初の出現を残す。
  const seenRef = new Set<string>()
  p.view.groupOrder = p.view.groupOrder.filter((r) => {
    const k = `${r.sourceId} ${r.groupId}`
    if (seenRef.has(k)) return false
    seenRef.add(k)
    return true
  })
  // enabledSourceIds も重複除去 (合流/復元で二重 push されうる)。
  p.enabledSourceIds = [...new Set(p.enabledSourceIds)]
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

// ── profile 操作 (Phase 2: プリセット切替) ──
// active profile を切替える (見つからなければ無視)。fetch 範囲 (enabledSources) が変わるため、
// 呼び出し側で saveConfig → setSourcesFromConfig → render を続ける。
export function setActiveProfile(cfg: Config, id: string): void {
  if (cfg.profiles.some((p) => p.id === id)) cfg.activeProfileId = id
}

// 空 view の新規 profile を追加し、active にする。enabledSourceIds は builtin + 全 server
// (新規 profile でも何も出ないと混乱するため既定で全 source を有効化)。追加した profile を返す。
export function addProfile(cfg: Config, name: string): Profile {
  const prof: Profile = {
    id: genProfileId(),
    name: name || 'New preset',
    enabledSourceIds: cfg.sources.map((s) => s.id),
    view: emptyProfileView(),
  }
  cfg.profiles.push(prof)
  cfg.activeProfileId = prof.id
  return prof
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

// ProfileView を deep copy する (複製時の参照共有を断つ)。ViewGroup / GroupRef / GlassLayout
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
  if (view.glassLayout) {
    const customLabels: Record<string, { text: string }> = {}
    for (const [id, v] of Object.entries(view.glassLayout.customLabels)) {
      customLabels[id] = { text: v.text }
    }
    next.glassLayout = { rows: view.glassLayout.rows.map((r) => [...r]), customLabels }
  }
  return next
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
// machineId を持つ source は削除前に表示レシピを tombstone (recentlyRemoved) へ退避し、
// 同一マシン再追加 (machineId 一致) で可視性/並び/glassLayout が復活する経路を残す。
export function removeSource(cfg: Config, id: string): void {
  if (id === BUILTIN_SOURCE_ID) return
  const removed = cfg.sources.find((s) => s.id === id)
  if (removed?.machineId) captureRemovedView(cfg, removed)
  discardSource(cfg, id)
}

// source と全 profile view 参照を物理削除する (tombstone を書かない内部 helper)。
// glassLayout からも当該 source の segKey を除去する (削除後に幽霊 chip を残さない。
// 配置の復元は tombstone 経由で行う)。
function discardSource(cfg: Config, id: string): void {
  if (id === BUILTIN_SOURCE_ID) return
  cfg.sources = cfg.sources.filter((s) => s.id !== id)
  delete cfg.groups[id]
  for (const p of cfg.profiles) {
    p.enabledSourceIds = p.enabledSourceIds.filter((sid) => sid !== id)
    delete p.view.groups[id]
    p.view.groupOrder = p.view.groupOrder.filter((r) => r.sourceId !== id)
    const lay = p.view.glassLayout
    if (lay) lay.rows = lay.rows.map((row) => row.filter((k) => k.split('|')[0] !== id))
  }
}

// 削除する source の表示レシピを全 profile から集めて tombstone に退避する (machineId キー)。
// view を一切持たない (どの profile にも配置されていない) なら退避しない。
function captureRemovedView(cfg: Config, src: SourceDef): void {
  const machineId = src.machineId
  if (!machineId) return
  const profiles: Record<string, RemovedSourceView> = {}
  for (const p of cfg.profiles) {
    const groups = p.view.groups[src.id]
    const groupRefs = p.view.groupOrder.filter((r) => r.sourceId === src.id).map((r) => r.groupId)
    const glassRows = collectGlassRows(p.view.glassLayout, src.id)
    const enabled = p.enabledSourceIds.includes(src.id)
    if (!groups && !groupRefs.length && !glassRows && !enabled) continue
    profiles[p.id] = {
      enabled,
      groups: groups ? structuredCloneGroups(groups) : {},
      groupRefs,
      glassRows,
    }
  }
  if (!Object.keys(profiles).length) return
  cfg.recentlyRemoved ??= {}
  cfg.recentlyRemoved[machineId] = { at: Date.now(), oldSourceId: src.id, profiles }
  pruneRemovedViews(cfg)
}

// glassLayout.rows のうち当該 source の segKey を含む行だけを profileId 用に抜き出す。
// 行 index を保ってオブジェクト化し、復元時に元の行へ戻す (他 source の chip には触れない)。
function collectGlassRows(
  lay: GlassLayout | undefined,
  sourceId: string,
): Record<string, string[][]> | null {
  if (!lay) return null
  const out: Record<string, string[][]> = {}
  lay.rows.forEach((row, i) => {
    const own = row.filter((k) => k.split('|')[0] === sourceId)
    if (own.length) out[String(i)] = [own]
  })
  return Object.keys(out).length ? out : null
}

function structuredCloneGroups(g: Record<string, ViewGroup>): Record<string, ViewGroup> {
  const out: Record<string, ViewGroup> = {}
  for (const [gid, vg] of Object.entries(g)) out[gid] = { ...vg, segments: { ...vg.segments } }
  return out
}

// tombstone を MAX_REMOVED_VIEWS 件に間引く (古い at から削除)。
function pruneRemovedViews(cfg: Config): void {
  const rv = cfg.recentlyRemoved
  if (!rv) return
  const keys = Object.keys(rv)
  if (keys.length <= MAX_REMOVED_VIEWS) return
  const stale = keys
    .sort((a, b) => (rv[a]?.at ?? 0) - (rv[b]?.at ?? 0))
    .slice(0, keys.length - MAX_REMOVED_VIEWS)
  for (const k of stale) delete rv[k]
}

// source の id を newId へ付け替え、素材 groups と全 profile の view 参照
// (groups / groupOrder / glassLayout.rows / enabledSourceIds) を旧 id から新 id へ remap する。
// 既存 randomUUID source が machineId を後付けで採用するときに過去の profile 参照を壊さないための要。
// newId が既に使われていれば何もしない (呼び出し側が衝突解決済みである前提)。
function reKeySource(cfg: Config, oldId: string, newId: string): void {
  if (oldId === newId) return
  if (cfg.sources.some((s) => s.id === newId)) return
  const src = cfg.sources.find((s) => s.id === oldId)
  if (!src) return
  src.id = newId
  if (cfg.groups[oldId]) {
    cfg.groups[newId] = cfg.groups[oldId]
    delete cfg.groups[oldId]
  }
  for (const p of cfg.profiles) {
    p.enabledSourceIds = p.enabledSourceIds.map((sid) => (sid === oldId ? newId : sid))
    if (p.view.groups[oldId]) {
      p.view.groups[newId] = p.view.groups[oldId]
      delete p.view.groups[oldId]
    }
    for (const r of p.view.groupOrder) if (r.sourceId === oldId) r.sourceId = newId
    const lay = p.view.glassLayout
    if (lay) lay.rows = lay.rows.map((row) => row.map((k) => reKeySegKey(k, oldId, newId)))
  }
}

// segKey (sourceId|groupId|segId) の先頭 sourceId を付け替える。custom ラベル / @right 等は素通し。
function reKeySegKey(key: string, oldId: string, newId: string): string {
  const parts = key.split('|')
  if (parts.length < 2 || parts[0] !== oldId) return key
  parts[0] = newId
  return parts.join('|')
}

// fromId の view 断片を toId へ統合する (同一マシンへの合流時。reKeySource と違い toId が
// 既存なので additive にマージし、toId の現状を優先する = ユーザーの現配置を壊さない)。
// 統合後も fromId 参照が残るが、呼び出し側の discardSource が物理削除する。
function mergeSourceViewInto(cfg: Config, fromId: string, toId: string): void {
  if (fromId === toId) return
  for (const p of cfg.profiles) {
    // enabledSourceIds: fromId が有効なら toId も有効化 (fetch 範囲を維持)。
    if (p.enabledSourceIds.includes(fromId) && !p.enabledSourceIds.includes(toId)) {
      p.enabledSourceIds.push(toId)
    }
    // view.groups: toId に無い groupId だけ移送 (clone)。既存は toId 側を優先。
    const fromGroups = p.view.groups[fromId]
    if (fromGroups) {
      p.view.groups[toId] ??= {}
      for (const [gid, vg] of Object.entries(fromGroups)) {
        p.view.groups[toId][gid] ??= { ...vg, segments: { ...vg.segments } }
      }
    }
    // groupOrder: toId に未登録の groupId だけ末尾へ追加 (順序維持)。
    const present = new Set(
      p.view.groupOrder.filter((r) => r.sourceId === toId).map((r) => r.groupId),
    )
    for (const r of p.view.groupOrder) {
      if (r.sourceId === fromId && !present.has(r.groupId)) {
        p.view.groupOrder.push({ sourceId: toId, groupId: r.groupId })
        present.add(r.groupId)
      }
    }
    mergeGlassRows(p.view.glassLayout, fromId, toId)
  }
}

// glassLayout.rows の fromId chip を toId へ remap する。重複は exact segKey 単位で排除する
// (同一 chip が rows に二重に乗ると同じ表示が 2 回出るため)。既に toId chip が在る位置を尊重し、
// 衝突しない fromId chip は配置を保ったまま remap する (additive)。
function mergeGlassRows(lay: GlassLayout | undefined, fromId: string, toId: string): void {
  if (!lay) return
  // 既に rows 内に存在する toId segKey 集合 (これと衝突する fromId chip は捨てる)。
  const present = new Set<string>()
  for (const row of lay.rows) {
    for (const k of row) {
      if (k.split('|')[0] === toId) present.add(k)
    }
  }
  lay.rows = lay.rows.map((row) =>
    row.flatMap((k) => {
      if (k.split('|')[0] !== fromId) return [k]
      const remapped = reKeySegKey(k, fromId, toId)
      if (present.has(remapped)) return [] // 同一 chip が既配置なら捨てる (重複防止)
      present.add(remapped)
      return [remapped]
    }),
  )
}

// 接続テスト成功後、編集中 source に machineId を反映して id を安定化する。返り値は確定した SourceDef。
//  1. 既に同 machineId の別 source があれば → url を urls に足すだけで合流し、編集 source は削除して合流先を返す。
//  2. machineId 派生 id が空 (フォールバック) → 既存挙動 (randomUUID 維持) で machineId だけ後付け。
//  3. それ以外 → 編集 source の id を machineId 派生 id へ reKey (衝突時は url hash で disambiguate)。
//     さらに tombstone (同 machineId) があれば profile の view を復元する。
export function reconcileSourceMachine(
  cfg: Config,
  editingId: string,
  machineId: string,
  url: string,
): SourceDef | null {
  const editing = cfg.sources.find((s) => s.id === editingId)
  if (!editing) return null

  // machineId は同一マシン判定 (合流・id 安定化) の唯一のキー。空/空白のみは identity に
  // 使えない (空同士・undefined 同士が一致して別マシンを 1 source に潰す誤合流 = データ破壊)。
  // その場合は machineId を一切代入せず、合流も id 安定化もせず editing をそのまま返す
  // (randomUUID を維持し、別マシンとの混線を構造的に排除する)。
  const mid = machineId.trim()
  if (!mid) return editing
  editing.machineId = mid

  // (1) 同 machineId の既存 source があれば url を足して合流する。編集中 source は
  //     物理削除するが、その前に全 profile の view 断片 (可視性/並び/glass 配置/enabled) を
  //     合流先 id へ統合する。編集中 source は設定済み source を edit-source で開いた実体で
  //     あり得る (placeholder とは限らない) ため、view を捨てると同一マシンなのに配置が消える。
  //     合流先の現配置を優先する additive 統合なので tombstone は不要。
  //     合流条件は s.machineId を truthy ガードする (空 machineId 同士の一致を防ぐ)。
  const merged = cfg.sources.find((s) => s.id !== editingId && !!s.machineId && s.machineId === mid)
  if (merged) {
    if (!merged.urls.includes(url)) merged.urls.push(url)
    merged.url ??= url
    mergeSourceViewInto(cfg, editingId, merged.id)
    discardSource(cfg, editingId)
    return merged
  }

  const base = deriveSourceId(mid)
  // (2) フォールバック: machineId が id 化できない (記号のみ等で deriveSourceId が '' を返す)
  //     → 既存 id を維持 (machineId のみ alias で付与済み)。合流もキー化もしない。
  if (!base) return editing

  // (3) 衝突回避: base が editing 以外で既に使われていれば url hash で別 id にする。
  const taken = cfg.sources.some((s) => s.id !== editingId && s.id === base)
  const newId = taken ? disambiguateSourceId(base, url) : base
  reKeySource(cfg, editingId, newId)
  restoreRemovedView(cfg, mid, newId)
  return cfg.sources.find((s) => s.id === newId) ?? editing
}

// tombstone (machineId 一致) があれば各 profile の view を復元する。素材 (cfg.groups) は
// status sync が再構築するので、ここでは可視性/並び/glassLayout/enabled だけ戻す。
// 既存 view を上書きしない (additive): 既に配置済みの group/order/行はユーザーの現状を優先する。
function restoreRemovedView(cfg: Config, machineId: string, newId: string): void {
  const tomb = cfg.recentlyRemoved?.[machineId]
  if (!tomb) return
  for (const p of cfg.profiles) {
    const snap = tomb.profiles[p.id]
    if (!snap) continue
    if (snap.enabled && !p.enabledSourceIds.includes(newId)) p.enabledSourceIds.push(newId)
    p.view.groups[newId] ??= {}
    for (const [gid, vg] of Object.entries(snap.groups)) {
      p.view.groups[newId][gid] ??= { ...vg, segments: { ...vg.segments } }
    }
    const present = new Set(
      p.view.groupOrder.filter((r) => r.sourceId === newId).map((r) => r.groupId),
    )
    for (const gid of snap.groupRefs) {
      if (!present.has(gid)) p.view.groupOrder.push({ sourceId: newId, groupId: gid })
    }
    restoreGlassRows(p, snap, tomb.oldSourceId, newId)
  }
  delete cfg.recentlyRemoved?.[machineId]
}

// tombstone の glass 行を現在の glassLayout へ戻す (旧 sourceId|... を newId|... へ remap)。
// 当該行に既に同 source の chip があれば上書きしない (ユーザーの現配置を尊重)。
function restoreGlassRows(
  p: Profile,
  snap: RemovedSourceView,
  oldSourceId: string,
  newId: string,
): void {
  const lay = p.view.glassLayout
  if (!lay || !snap.glassRows) return
  for (const [idxStr, rows] of Object.entries(snap.glassRows)) {
    const i = Number(idxStr)
    if (!Number.isInteger(i) || i < 0 || i >= lay.rows.length) continue
    const keys = (rows[0] ?? []).map((k) => reKeySegKey(k, oldSourceId, newId))
    const row = lay.rows[i] ?? []
    if (row.some((k) => k.split('|')[0] === newId)) continue // 既配置は尊重
    lay.rows[i] = [...row, ...keys]
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
      // groupOrder に同 ref が既にあれば push しない (groups と groupOrder の一時的不整合での二重登録防止)。
      if (!view.groupOrder.some((r) => r.sourceId === sourceId && r.groupId === g.id)) {
        view.groupOrder.push({ sourceId, groupId: g.id })
      }
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
