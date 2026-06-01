// 表示モデル Phase2: 同系統データ衝突の検出と displayLabel 解決 (tasks/display-model-spec.md)。
// 内部 identity(sourceId>groupId>segmentId)とは別に、表示で出自(owner)を区別するための純関数群。
// 衝突検出は config(sources+categories)のみで構造的に決める = online/offline で揺れない。
// displayLabel 文字列だけ live status の label を使って組む(companion が持つ statuses を渡す)。
import {
  BUILTIN_GROUP_LABELS,
  BUILTIN_SOURCE_ID,
  type Config,
  type SourceDef,
  sourceById,
} from './config'
import type { Group, StatusDoc } from './status-types'
import { segKey } from './visibility/keys'

// source の表示オーナー。明示 displayOwner があればそれ、無ければ source.label にフォールバック。
export function effectiveOwner(source: SourceDef): string {
  return source.displayOwner?.trim() || source.label
}

// group の base label (companion/glass の見出しと同じ規則)。builtin はコード所有ラベル、他は live group.label。
function groupBaseLabel(
  config: Config,
  sourceId: string,
  groupId: string,
  liveGroup: Group | undefined,
): string {
  if (sourceId === BUILTIN_SOURCE_ID) return BUILTIN_GROUP_LABELS[groupId] ?? groupId
  return liveGroup?.label || sourceById(config, sourceId)?.label || groupId
}

// group id から衝突区別子を作る ('claude-limits' -> 'limits'、'-' 無しは id 全体)。
function groupSuffix(groupId: string): string {
  const i = groupId.lastIndexOf('-')
  return i >= 0 && i < groupId.length - 1 ? groupId.slice(i + 1) : groupId
}

// 同一 source 内で base label が衝突する group に displayName を解決する。
// 返り値 'sourceId|groupId' -> string(設定: '<label> (<suffix>)') | null(クリア)。
// 代表(groupId 昇順の先頭)は label のまま(null)、残りに suffix を付ける。
// live status に無い(offline/未取得)group は map に含めない(= 既存値を維持。揺らさない)。
// 前提: group の base label は静的(producer の固定リテラル)であること。変動値(時刻/カウント等)を
// group label に混ぜると poll 毎に desired が変わり companion で毎 poll saveConfig する churn を招く
// (resolveDisplayLabels と同じ注意。外部 JS provider を増やす際の罠)。
export function resolveGroupDisplayNames(
  config: Config,
  statuses: Record<string, StatusDoc | null>,
): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const src of config.sources) {
    const groups = config.groups[src.id]
    if (!groups) continue
    const doc = statuses[src.id]
    // この source の live group ごとに base label を集める (offline group は対象外)。
    const byLabel = new Map<string, { groupId: string; label: string }[]>()
    for (const gid of Object.keys(groups)) {
      const liveGroup = doc?.groups.find((g) => g.id === gid)
      if (!liveGroup) continue
      const label = groupBaseLabel(config, src.id, gid, liveGroup)
      const arr = byLabel.get(label) ?? []
      arr.push({ groupId: gid, label })
      byLabel.set(label, arr)
    }
    for (const [label, items] of byLabel) {
      if (items.length < 2) {
        for (const it of items) out.set(`${src.id}|${it.groupId}`, null) // 衝突なし → クリア
        continue
      }
      const sorted = [...items].sort((a, b) => a.groupId.localeCompare(b.groupId))
      sorted.forEach((it, i) => {
        out.set(`${src.id}|${it.groupId}`, i === 0 ? null : `${label} (${groupSuffix(it.groupId)})`)
      })
    }
  }
  return out
}

// 「同一 category leaf を 2 つ以上の異なる owner が出す」category 集合。
// ここに属する category の segment だけが owner prefix で区別される(構造的・status 非依存)。
export function collisionCategories(config: Config): Set<string> {
  const ownersByCat = new Map<string, Set<string>>()
  for (const src of config.sources) {
    const groups = config.groups[src.id]
    if (!groups) continue
    const owner = effectiveOwner(src)
    for (const meta of Object.values(groups)) {
      for (const sm of meta.segments) {
        if (!sm.category) continue
        const set = ownersByCat.get(sm.category) ?? new Set<string>()
        set.add(owner)
        ownersByCat.set(sm.category, set)
      }
    }
  }
  const out = new Set<string>()
  for (const [cat, owners] of ownersByCat) if (owners.size >= 2) out.add(cat)
  return out
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
      for (const sm of meta.segments) {
        if (!sm.category) continue
        const liveSeg = liveGroup?.segments.find((s) => s.id === sm.id)
        if (!liveSeg) continue // offline/未取得は触らない(揺らさない)
        const key = segKey(src.id, gid, sm.id)
        if (!collide.has(sm.category)) {
          out.set(key, null) // 非衝突 → クリア
          continue
        }
        out.set(key, liveSeg.label ? `${owner} ${liveSeg.label}` : owner)
      }
    }
  }
  return out
}
