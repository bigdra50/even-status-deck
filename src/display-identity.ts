// 表示モデル Phase2: 同系統データ衝突の検出と displayLabel 解決 (tasks/display-model-spec.md)。
// 内部 identity(sourceId>groupId>segmentId)とは別に、表示で出自(owner)を区別するための純関数群。
// 衝突検出は config(sources+categories)のみで構造的に決める = online/offline で揺れない。
// displayLabel 文字列だけ live status の label を使って組む(companion が持つ statuses を渡す)。
import {
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  type Config,
  type GroupMeta,
  type GroupRef,
  type ProfileView,
  type SourceDef,
} from './config'
import type { Group, StatusDoc } from './status-types'
import { segKey } from './visibility/keys'

// source の表示オーナー。明示 displayOwner があればそれ、無ければ source.label にフォールバック。
export function effectiveOwner(source: SourceDef): string {
  return source.displayOwner?.trim() || source.label
}

// group の effective 見出し (merge identity)。ユーザー rename(displayName) を最優先し、builtin は
// コード所有ラベル、他は sync が記録した lastLabel。live label に直接依存しないことで offline でも
// unit 構成が揺れない。表示専用のフォールバック (source label / groupId) はここでは持たない
// (空見出しはマージ対象外なので、表示側が好きに補ってよい)。
// 前提: group label は静的(producer の固定リテラル)であること。変動値(時刻/カウント等)を label に
// 混ぜると poll 毎に lastLabel が変わり sync が毎回 saveConfig する churn を招く(外部 provider の罠)。
export function effectiveGroupHeading(config: Config, sourceId: string, groupId: string): string {
  const meta = config.groups[sourceId]?.[groupId]
  if (meta?.displayName) return meta.displayName
  if (sourceId === BUILTIN_SOURCE_ID) return BUILTIN_GROUP_LABELS[groupId] ?? groupId
  return meta?.lastLabel ?? ''
}

// 見出し等価判定の正規化 (NFC + trim。case は区別)。merge 判定・custom layout の label dedup・
// companion の rename confirm で必ずこれを共有する (判定ズレで「表示はマージ・確認は非マージ」を防ぐ)。
export function normalizeHeading(s: string): string {
  return s.normalize('NFC').trim()
}

// glass の表示単位。同一 source 内で正規化見出しが一致する group は 1 unit にマージ表示する
// (例: builtin 'claude-code' と外部 provider 'claude-limits' が両方 'Claude' → 1 行/1 ページ)。
export type GroupMergeUnit = {
  heading: string // 代表 member の effective 見出し ('' = 見出し無し)
  rep: GroupRef // 代表 = groupOrder 先頭 member (静的)。unit の位置・align はこれに従う
  members: GroupRef[] // groupOrder 順。offline/disabled member も含む (segment を出さないだけ)
}

// view.groupOrder を merge unit 列に畳む。config のみで完結する静的計算 (statuses 非依存) なので
// online/offline・enable 切替で unit 構成・代表・align が揺れない。空見出しと cross-source は
// マージしない (別マシンの同名 group は別物)。
export function computeGroupMergeUnits(config: Config, view: ProfileView): GroupMergeUnit[] {
  const units: GroupMergeUnit[] = []
  const byKey = new Map<string, GroupMergeUnit>()
  for (const ref of view.groupOrder) {
    if (!config.groups[ref.sourceId]?.[ref.groupId]) continue // 素材に無い ref は描画対象外 (renderer と同じ)
    const heading = effectiveGroupHeading(config, ref.sourceId, ref.groupId)
    const key = normalizeHeading(heading)
    if (!key) {
      units.push({ heading, rep: ref, members: [ref] }) // 空見出しは常に単独
      continue
    }
    const unitKey = `${ref.sourceId}\u0000${key}`
    const existing = byKey.get(unitKey)
    if (existing) {
      existing.members.push(ref)
    } else {
      const unit: GroupMergeUnit = { heading, rep: ref, members: [ref] }
      byKey.set(unitKey, unit)
      units.push(unit)
    }
  }
  return units
}

// 1 group が持つ category 付き segment ぶん、ownersByCat に owner を登録する (collisionCategories の内側ループ)。
function registerCategoryOwners(
  ownersByCat: Map<string, Set<string>>,
  owner: string,
  meta: GroupMeta,
): void {
  for (const sm of meta.segments) {
    if (!sm.category) continue
    const set = ownersByCat.get(sm.category) ?? new Set<string>()
    set.add(owner)
    ownersByCat.set(sm.category, set)
  }
}

// 「同一 category leaf を 2 つ以上の異なる owner が出す」category 集合。
// ここに属する category の segment だけが owner prefix で区別される(構造的・status 非依存)。
export function collisionCategories(config: Config): Set<string> {
  const ownersByCat = new Map<string, Set<string>>()
  for (const src of config.sources) {
    const groups = config.groups[src.id]
    if (!groups) continue
    const owner = effectiveOwner(src)
    for (const meta of Object.values(groups)) registerCategoryOwners(ownersByCat, owner, meta)
  }
  const out = new Set<string>()
  for (const [cat, owners] of ownersByCat) if (owners.size >= 2) out.add(cat)
  return out
}

// 1 group ぶんの segment を解決し、out に書き込む (resolveDisplayLabels の内側ループ)。
// live status に無い(offline/未取得)segment は触らない(map に含めない = 既存値を維持)。
function resolveGroupDisplayLabels(
  out: Map<string, string | null>,
  sourceId: string,
  owner: string,
  gid: string,
  meta: GroupMeta,
  liveGroup: Group | undefined,
  collide: Set<string>,
): void {
  for (const sm of meta.segments) {
    if (!sm.category) continue
    const liveSeg = liveGroup?.segments.find((s) => s.id === sm.id)
    if (!liveSeg) continue // offline/未取得は触らない(揺らさない)
    const key = segKey(sourceId, gid, sm.id)
    if (!collide.has(sm.category)) {
      out.set(key, null) // 非衝突 → クリア
      continue
    }
    out.set(key, liveSeg.label ? `${owner} ${liveSeg.label}` : owner)
  }
}

// 各 segment の desired displayLabel を解決する。返り値 segKey -> string(設定) | null(クリア)。
// - collision category の segment: `${owner} ${liveLabel}`(label が空なら owner のみ)。
// - 非 collision の segment: null(= displayLabel をクリア)。
// - live status に無い(offline/未取得)segment: map に含めない(= 既存値を維持。online/offline で揺らさない)。
// 前提: 衝突対象 category の segment.label は静的(id 由来。例 'Bat')であること。変動値(時刻等)が label に
// 混ざる category を衝突対象にすると poll 毎に desired が変わり、companion 側で毎 poll saveConfig する churn を招く。
// 変動値は value 側に分離する現行 producer の規約を保つこと(Phase3 で衝突 category を増やす際の注意)。
export function resolveDisplayLabels(
  config: Config,
  statuses: Record<string, StatusDoc | null>,
): Map<string, string | null> {
  const collide = collisionCategories(config)
  const out = new Map<string, string | null>()
  for (const src of config.sources) {
    const groups = config.groups[src.id]
    if (!groups) continue
    const owner = effectiveOwner(src)
    const doc = statuses[src.id]
    for (const [gid, meta] of Object.entries(groups)) {
      const liveGroup = doc?.groups.find((g) => g.id === gid)
      resolveGroupDisplayLabels(out, src.id, owner, gid, meta, liveGroup, collide)
    }
  }
  return out
}
