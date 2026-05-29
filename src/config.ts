import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { MAX_ROWS } from './glass-render'
import { defaultImuConfig, type ImuConfig } from './imu'
import type { StatusDoc } from './status-types'
import { segKey, type VisibilityCond, type VisibilityLeaf } from './visibility'

// 設定 (v3): 複数データソースを横断して描画する。source は builtin(client算出) か server(URL)。
// group/segment トグルと並び順を source 名前空間付きで保持する (codex 指摘: 不変ID + structured key)。
export const CONFIG_VERSION = 3
export const BUILTIN_SOURCE_ID = 'builtin.local'
// 暗黙の既定サーバ (同一オリジン) の決定的 ID。起動毎にランダム ID で再追加すると groupOrder が
// 孤立蓄積するため、固定 ID にして二重 init / 再起動でも同一ソースに収束させる。
export const LOCAL_SOURCE_ID = 'server.local'

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
export type SourceDef = { id: string; kind: SourceKind; label: string; url?: string }
// format: clock segment (time/date/datetime) の表示フォーマット文字列 (例 'HH:mm')。
//   未設定はロケール既定 (builtins.defaultClockFormat)。clock 以外では未使用。
export type SegCfg = { id: string; enabled: boolean; visibility?: VisibilityCond; format?: string }
export type GAlign = 'top' | 'bottom'
// align: glass summary での縦寄せ。未指定は 'top' (上から詰める従来挙動)。
// showDefaultLabel: glass で各 segment の前に group ラベル (G2/Claude 等) を出すか。
//   隣接する同 group の run では先頭の 1 回だけ表示 (rowText が dedup)。未指定は clock=false / 他=true。
export type GroupCfg = {
  enabled: boolean
  expanded: boolean
  align?: GAlign
  showDefaultLabel?: boolean
  segments: SegCfg[]
}

// group の default-label 既定値: builtin clock のみ OFF (時刻に 'Clock' は不要)、他は ON。
export function defaultShowGroupLabel(groupId: string): boolean {
  return groupId !== 'clock'
}
export type GroupRef = { sourceId: string; groupId: string }

// glass の行レイアウト (表示レシピ)。group (素材) とは独立した固定 MAX_ROWS 行スロット。
// rows[i] = i 行目の segKey 並び (空行可)。anchor は廃止 (行番号 = 絶対行位置)。
// どの行にも無い enabled segment は companion の Unplaced 棚に自動表示 (導出。新規 segment も
// 自動で棚に出る)。未設定 (undefined) の間は従来の group=1行 自動描画。companion の Customize
// で生成・固定する (以降 status 増減で自動変更しない)。
export type GlassLayout = {
  rows: string[][] // rows.length === MAX_ROWS。各要素 = key (segKey / @label / @customLabel:id)
  customLabels: Record<string, { text: string }> // ユーザー定義ラベルの本文 (id -> text)
}
// IMU 方向検出は src/imu ライブラリが所有。Config は enable + キャリブの永続先として imu? を持つ。
export type Config = {
  version: number
  sources: SourceDef[]
  groups: Record<string, Record<string, GroupCfg>> // sourceId -> groupId -> cfg (nested = delimiter 衝突なし)
  groupOrder: GroupRef[] // 全ソース横断の表示順
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
  if (!bg.clock)
    bg.clock = { enabled: true, expanded: false, showDefaultLabel: false, segments: [] }
  if (!bg.g2) bg.g2 = { enabled: true, expanded: false, showDefaultLabel: true, segments: [] }
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
    delete (c as Record<string, unknown>).glassHints // glassHints 廃止 (操作説明は companion 常設へ)
    // default-label (showDefaultLabel) を group ごとに補完 (additive、bump 不要)
    for (const [, gs] of Object.entries(c.groups ?? {})) {
      for (const [gid, gc] of Object.entries(gs)) gc.showDefaultLabel ??= defaultShowGroupLabel(gid)
    }
    normalizeVisibilityAll(c) // 旧 single-cond 形式の visibility を複合形式へ正規化 (additive、bump 不要)
    // glassLayout を新形式に正規化 (旧 anchor 形式は移行、壊れていれば undefined=自動描画)
    c.glassLayout = normalizeGlassLayout((c as Record<string, unknown>).glassLayout)
    consolidateClock(c) // clock を単一 datetime segment に統合 (旧 time/date を remap、additive)
    pruneOrphans(c) // sources に無い孤立 groupOrder/groups を掃除 (暗黙サーバ旧ランダム ID の蓄積を修復)
    return c
  }
  const old = parsed as {
    machines?: Record<string, OldMachine>
  }
  const cfg = emptyConfig()
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

function emptyRows(): string[][] {
  return Array.from({ length: MAX_ROWS }, () => [])
}

// glass layout を現在の groupOrder + enabled segment から生成する (Customize 時の初期値)。
// 1 group = 1 行を上から詰める。MAX_ROWS を超えた分は配置せず Unplaced 棚 (導出) に出る。
export function generateGlassLayout(cfg: Config): GlassLayout {
  const rows = emptyRows()
  let i = 0
  for (const ref of cfg.groupOrder) {
    const gc = cfg.groups[ref.sourceId]?.[ref.groupId]
    if (!gc?.enabled) continue
    const items = gc.segments
      .filter((s) => s.enabled)
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
// SegCfg から time/date を除去し datetime を有効化、glassLayout の旧キーを datetime へ remap (重複は1つに)。
function consolidateClock(c: Config): void {
  const clock = c.groups[BUILTIN_SOURCE_ID]?.clock
  if (clock) {
    const timeSeg = clock.segments.find((s) => s.id === 'time')
    const dateSeg = clock.segments.find((s) => s.id === 'date')
    const dt = clock.segments.find((s) => s.id === 'datetime')
    if (!dt) {
      // 旧 time/date を 1 つの datetime に統合: format を合成 (区切り 2 スペース)、enabled を継承。
      const fmt = [timeSeg?.format ?? '', dateSeg?.format ?? ''].filter(Boolean).join('  ')
      const enabled = timeSeg || dateSeg ? !!(timeSeg?.enabled || dateSeg?.enabled) : true
      const seg: SegCfg = { id: 'datetime', enabled }
      if (fmt) seg.format = fmt
      clock.segments.push(seg)
    }
    // 既存 datetime は format/enabled をそのまま保持 (上書きしない)
    clock.segments = clock.segments.filter((s) => s.id !== 'time' && s.id !== 'date')
  }
  const lay = c.glassLayout
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
export function addServer(cfg: Config, label: string, url?: string): SourceDef {
  const def: SourceDef = { id: genSourceId(), kind: 'server', label, url }
  cfg.sources.push(def)
  cfg.groups[def.id] = {}
  return def
}

// 暗黙の既定サーバ (同一オリジン) を決定的 ID で保証する。server が 1 つも無いときだけ追加する。
// addServer (ランダム ID) と違い固定 ID なので、bridge 準備前後の二重 init や再起動で再追加されても
// 同一ソースに収束し、groupOrder/groups が孤立蓄積しない。追加したら true。
export function ensureDefaultServer(cfg: Config, url: string): boolean {
  if (cfg.sources.some((s) => s.kind === 'server')) return false
  cfg.sources.push({ id: LOCAL_SOURCE_ID, kind: 'server', label: 'Local', url })
  cfg.groups[LOCAL_SOURCE_ID] ??= {}
  return true
}

// ソースを削除する (builtin は不可)。group 設定と groupOrder も掃除する。
export function removeSource(cfg: Config, id: string): void {
  if (id === BUILTIN_SOURCE_ID) return
  cfg.sources = cfg.sources.filter((s) => s.id !== id)
  delete cfg.groups[id]
  cfg.groupOrder = cfg.groupOrder.filter((r) => r.sourceId !== id)
}

// sources に存在しない sourceId の groupOrder / groups を掃除する (孤立エントリ除去)。
// 暗黙サーバの旧ランダム ID 等が groupOrder に孤立蓄積した不整合を、読み込み時に修復する。
function pruneOrphans(cfg: Config): void {
  const ids = new Set(cfg.sources.map((s) => s.id))
  cfg.groupOrder = cfg.groupOrder.filter((r) => ids.has(r.sourceId))
  for (const sid of Object.keys(cfg.groups)) {
    if (!ids.has(sid)) delete cfg.groups[sid]
  }
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
      gc = {
        enabled: true,
        expanded: false,
        showDefaultLabel: defaultShowGroupLabel(g.id),
        segments: [],
      }
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
