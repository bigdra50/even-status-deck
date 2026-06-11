import { defaultCategory } from '../taxonomy'
import type { CondDisplay, DisplayUi, VisibilityCond, VisibilityLeaf } from '../visibility/keys'
import { defaultShowGroupLabel } from './ids'
import { normalizeGlassLayout } from './layout'
import { emptyProfileView } from './profiles'
import type { Config, GroupMeta, OptionValues, Profile, SegMeta, SourceDef } from './types'

// 旧 url? を urls[0] へ正規化する (urls 不在なら url から、両方あれば url を先頭に補完)。
export function normalizeSourceUrls(s: SourceDef): void {
  if (!Array.isArray(s.urls)) s.urls = []
  if (s.url && !s.urls.includes(s.url)) s.urls.unshift(s.url)
}

// threshold leaf を sanitize する。op/value が不正なら null。
function sanitizeThresholdLeaf(o: Record<string, unknown>): VisibilityLeaf | null {
  if (
    !(o.kind === 'threshold' && (o.op === 'lte' || o.op === 'gte') && typeof o.value === 'number')
  )
    return null
  const leaf: VisibilityLeaf = { kind: 'threshold', op: o.op, value: o.value }
  if (typeof o.seg === 'string' && o.seg !== '') leaf.seg = o.seg // 対象 = 同 group 内の兄弟。空=self
  return leaf
}

// onChange leaf を sanitize する。holdMs が不正なら null。
function sanitizeOnChangeLeaf(o: Record<string, unknown>): VisibilityLeaf | null {
  if (!(o.kind === 'onChange' && typeof o.holdMs === 'number')) return null
  const leaf: VisibilityLeaf = { kind: 'onChange', holdMs: o.holdMs }
  if (typeof o.seg === 'string' && o.seg !== '') leaf.seg = o.seg
  return leaf
}

// present leaf を sanitize する。seg が不正なら null。
function sanitizePresentLeaf(o: Record<string, unknown>): VisibilityLeaf | null {
  if (!(o.kind === 'present' && typeof o.seg === 'string' && o.seg !== '')) return null
  const leaf: VisibilityLeaf = { kind: 'present', seg: o.seg }
  if (o.absent === true) leaf.absent = true
  return leaf
}

// 1 leaf を sanitize する。不正なら null。threshold は op/value、onChange は holdMs を検証。
function sanitizeLeaf(x: unknown): VisibilityLeaf | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  return sanitizeThresholdLeaf(o) ?? sanitizeOnChangeLeaf(o) ?? sanitizePresentLeaf(o)
}

const DISPLAY_UIS: ReadonlySet<string> = new Set(['toast', 'notification'])
const MAX_DISPLAY_TEXT_LEN = 80
const MIN_DISPLAY_MS = 1000
const MAX_DISPLAY_MS = 60_000

// 提示先 (display) を sanitize する。ui が既知でなければ undefined (= inline persistent に戻る)。
// 旧 banner/dialog は許可リスト外なので落ち、inline に戻る。text は trim + 上限。
// durationMs は 1..60s に clamp (自動非表示の秒数)。
function sanitizeCondDisplay(x: unknown): CondDisplay | undefined {
  if (!x || typeof x !== 'object') return undefined
  const o = x as Record<string, unknown>
  if (typeof o.ui !== 'string' || !DISPLAY_UIS.has(o.ui)) return undefined
  const out: CondDisplay = { ui: o.ui as DisplayUi }
  if (typeof o.text === 'string') {
    const t = o.text.trim().slice(0, MAX_DISPLAY_TEXT_LEN)
    if (t) out.text = t
  }
  if (typeof o.durationMs === 'number' && Number.isFinite(o.durationMs)) {
    out.durationMs = Math.max(MIN_DISPLAY_MS, Math.min(Math.round(o.durationMs), MAX_DISPLAY_MS))
  }
  return out
}

// segment の visibility を複合形式へ正規化する。新形式は leaf を sanitize、空なら undefined。
// 旧 single-cond ({kind:'always'|'threshold'|'onChange'}) は複合形式へ移行 (always=undefined)。
// display は additive。条件が空のとき display は無意味なので落とす (= inline persistent)。
function normalizeVisibility(v: unknown): VisibilityCond | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (Array.isArray(o.conditions)) {
    const conditions = o.conditions.map(sanitizeLeaf).filter((l): l is VisibilityLeaf => l !== null)
    if (conditions.length === 0) return undefined
    const out: VisibilityCond = { combinator: o.combinator === 'or' ? 'or' : 'and', conditions }
    const display = sanitizeCondDisplay(o.display)
    if (display) out.display = display
    return out
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

// options バッグ持ちオブジェクトの options を sanitize 結果で置き換える (空なら delete)。
function applyNormalizedOptions(target: { options?: OptionValues }): void {
  const next = normalizeOptionsBag(target.options)
  if (next) target.options = next
  else delete target.options
}

// 全 source / 素材 segment の options バッグを sanitize する (壊れた options でクラッシュさせない)。
export function normalizeOptionsAll(c: Config): void {
  for (const s of c.sources) applyNormalizedOptions(s)
  for (const groups of Object.values(c.groups ?? {})) {
    for (const meta of Object.values(groups)) {
      for (const sm of meta.segments) applyNormalizedOptions(sm)
    }
  }
}

// 素材側 segment の visibility を正規化する (素材は profile 非依存)。
export function normalizeMetaVisibilityAll(c: Config): void {
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

// tag 文字列の上限長 (異常データ/巨大値の防御。横断フィルタのラベルなので短くてよい)。
const MAX_TAG_LEN = 32

// 素材 segment の category を backfill/sanitize する (tasks/display-model-spec.md)。
// 未設定/非文字列/空文字は defaultCategory(groupId|segId) で埋める = migrate 後は常に category が付く
// (「category 必須」の意味づけ)。sync 前に素材化済みの旧 config も全 segment に category が付く。
export function normalizeMetaCategoryAll(c: Config): void {
  for (const groups of Object.values(c.groups ?? {})) {
    for (const [gid, meta] of Object.entries(groups)) {
      for (const sm of meta.segments) {
        if (typeof sm.category !== 'string' || sm.category === '') {
          sm.category = defaultCategory(gid, sm.id)
        }
      }
    }
  }
}

// source の displayOwner を sanitize する (非文字列/空文字は外す)。Phase1 は seed しない
// (builtin g2 のみ ensureBuiltin で注入)。owner 既定の本格 seed は Phase2 (バッジ UI が消費する時点)。
export function normalizeSourceDisplayOwner(c: Config): void {
  for (const s of c.sources) {
    if (
      s.displayOwner !== undefined &&
      (typeof s.displayOwner !== 'string' || s.displayOwner === '')
    ) {
      delete s.displayOwner
    }
  }
}

// 1 segment の tags を sanitize する (配列以外は外す / 非文字列・空を除去 / 重複除去 / 長さ制限)。
function normalizeSegTags(sm: SegMeta): void {
  if (sm.tags === undefined) return
  if (!Array.isArray(sm.tags)) {
    delete sm.tags
    return
  }
  const cleaned = [
    ...new Set(
      sm.tags
        .filter((t): t is string => typeof t === 'string' && t !== '')
        .map((t) => t.slice(0, MAX_TAG_LEN)),
    ),
  ]
  if (cleaned.length) sm.tags = cleaned
  else delete sm.tags
}

// 素材 segment の tags を sanitize する (配列以外は外す / 非文字列・空を除去 / 重複除去 / 長さ制限)。
// Phase1 は producer が tags を出さないので大半 undefined。型と正規化だけ先に確定させる (Phase3 再移行回避)。
export function normalizeTagsAll(c: Config): void {
  for (const groups of Object.values(c.groups ?? {})) {
    for (const meta of Object.values(groups)) {
      for (const sm of meta.segments) normalizeSegTags(sm)
    }
  }
}

// profile.view の glassLayout / groupOrder / ViewGroup を正規化する (additive)。
export function normalizeProfileView(p: Profile): void {
  p.view ??= emptyProfileView()
  p.view.groups ??= {}
  if (!Array.isArray(p.view.groupOrder)) p.view.groupOrder = []
  // groupOrder は (sourceId,groupId) で一意。machineId remap や旧バージョン移行で混入した
  // 重複を除去する (重複すると同じ group が Items / glass に二重表示される)。最初の出現を残す。
  const seenRef = new Set<string>()
  p.view.groupOrder = p.view.groupOrder.filter((r) => {
    const k = `${r.sourceId}\u0000${r.groupId}`
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

// 1 group の displayName / lastLabel を sanitize する。旧 'auto'(衝突自動命名 'Claude (limits)' 世代) は
// displayName ごと一掃する (リネーム廃止→同見出し group はマージ表示へ移行)。'auto' 完全一致以外の
// displayName はユーザー命名として保全し、廃止フィールド displayNameSource は常に落とす。
// lastLabel は非文字列/空を外すだけ (sync が live label を再捕捉する)。冪等。
function sanitizeGroupDisplayName(meta: GroupMeta): void {
  const legacy = meta as GroupMeta & { displayNameSource?: unknown }
  if (legacy.displayNameSource === 'auto') delete meta.displayName
  delete legacy.displayNameSource
  if (
    meta.displayName !== undefined &&
    (typeof meta.displayName !== 'string' || meta.displayName === '')
  ) {
    delete meta.displayName
  }
  if (
    meta.lastLabel !== undefined &&
    (typeof meta.lastLabel !== 'string' || meta.lastLabel === '')
  ) {
    delete meta.lastLabel
  }
}

// group displayName / lastLabel の sanitize を全 group に適用する。
function normalizeGroupDisplayNames(c: Config): void {
  for (const groups of Object.values(c.groups ?? {})) {
    for (const meta of Object.values(groups)) sanitizeGroupDisplayName(meta)
  }
}

// 表示モデル Phase1 の正規化 (category backfill / displayOwner / tags sanitize) をまとめて流す。
// 全 migrate 経路 (v4Same / v3 / legacy) で同一に呼ぶための共通ヘルパ。
// 重要: category seed は group id の remap (mac→system / clock 統合) の「後」に呼ぶこと。
// 先に呼ぶと旧 group id (mac 等) でキーが引けず custom に誤確定し、文字列ゆえ二度と矯正されない。
export function normalizeDisplayMeta(c: Config): void {
  normalizeMetaCategoryAll(c) // 素材 segment の category を backfill/sanitize
  normalizeSourceDisplayOwner(c) // source の displayOwner を sanitize
  normalizeTagsAll(c) // 素材 segment の tags を sanitize
  normalizeGroupDisplayNames(c) // group の displayName/displayNameSource を sanitize
}

// 永続化された recentlyRemoved を検証・間引く。壊れた entry は破棄し、件数上限を超えたら古い順に削る。
export function normalizeRemovedViews(c: Config): void {
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

// tombstone の保持上限 (古いものから間引く)。無制限に溜めない。
const MAX_REMOVED_VIEWS = 16

// tombstone を MAX_REMOVED_VIEWS 件に間引く (古い at から削除)。
export function pruneRemovedViews(cfg: Config): void {
  const rv = cfg.recentlyRemoved
  if (!rv) return
  const keys = Object.keys(rv)
  if (keys.length <= MAX_REMOVED_VIEWS) return
  const stale = keys
    .sort((a, b) => (rv[a]?.at ?? 0) - (rv[b]?.at ?? 0))
    .slice(0, keys.length - MAX_REMOVED_VIEWS)
  for (const k of stale) delete rv[k]
}
