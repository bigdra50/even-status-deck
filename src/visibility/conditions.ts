// 表示タイミング条件の純粋コア。segment 単位で「条件を満たすときだけ表示」を判定する。
// 条件は leaf(threshold/onChange/present/inPlace) の AND/OR 複合。
// threshold/onChange の対象は leaf.seg (同 group 内の兄弟 segment) を指定でき、省略時は self。
// present は別 segment が値を持つか(absent=空か)。threshold は percent 比較、onChange は value 変化で
// holdMs だけ表示。transient(onChange) の状態は呼び出し側 (runtime shell) が保持し、ここは pure に
// 受け渡す。config / status-types は型のみ参照。
import { activeView, type Config } from '../config'
import type { Segment, StatusDoc } from '../status-types'
import {
  segKey,
  type VisibilityCond,
  type VisibilityLeaf,
  type VisibleMap,
  type VisStates,
} from './keys'

// tri-state: 評価不能 ('na') は combine で中立扱いし fail-open を成立させる。
type LeafResult = boolean | 'na'

export function defaultVisibilityCond(): VisibilityCond {
  return { combinator: 'and', conditions: [] }
}

// threshold leaf を pure 評価する。percent 無しは 'na' (評価不能 → combine で中立)。
function evalThreshold(
  leaf: Extract<VisibilityLeaf, { kind: 'threshold' }>,
  seg: Segment,
): LeafResult {
  if (typeof seg.percent !== 'number') return 'na'
  return leaf.op === 'lte' ? seg.percent <= leaf.value : seg.percent >= leaf.value
}

// tri-state 列を結合する。'na' を除外し、残り 0 個は fail-open(true)。
// それ以外は and=全 true / or=いずれか true。
function combine(results: LeafResult[], combinator: 'and' | 'or'): boolean {
  const evaluable = results.filter((r): r is boolean => r !== 'na')
  if (evaluable.length === 0) return true
  return combinator === 'and' ? evaluable.every(Boolean) : evaluable.some(Boolean)
}

// 全 segment の可視マップを算出する (pure・状態受け渡し)。prev (onChange leaf の前回値/活性期限) を読み、
// 新 states + map + 次回 wake 時刻を返す。条件無し (conditions 空) と status 未到着は map に載せない
// (isVisible 既定 true、map を小さく保つ)。runtime shell が states を保持し wakeAt でタイマーを張る。
//   threshold leaf: seg.percent を op 比較 (percent 無し=na)
//   onChange leaf : seg.value が prev と変われば activeUntil=now+holdMs。初回観測 (prev 無し) は
//                   activeUntil=0 (非表示、フラッシュ防止)。leaf 結果 = now < activeUntil。
//   結合: combine(leaf 結果列, combinator)
export function computeVisibleMap(
  config: Config,
  statuses: Record<string, StatusDoc | null>,
  prev: VisStates,
  now: number,
  insidePlaceIds: Set<string> | null = null, // #43 現在ジオフェンス圏内の地点 id 集合。null=位置不明(na)
): { map: VisibleMap; states: VisStates; wakeAt: number | null } {
  const map: VisibleMap = new Map()
  const states: VisStates = new Map() // onChange leaf のみ。毎回再構築 → stale キーは自然消滅
  let wakeAt: number | null = null
  const view = activeView(config)
  for (const ref of view.groupOrder) {
    const meta = config.groups[ref.sourceId]?.[ref.groupId]
    if (!meta) continue
    const group = statuses[ref.sourceId]?.groups.find((g) => g.id === ref.groupId)
    if (!group) continue
    for (const sm of meta.segments) {
      const cond = sm.visibility
      if (!cond || cond.conditions.length === 0) continue // 条件無し = 常時表示 (map に載せない)
      const seg = group.segments.find((s) => s.id === sm.id)
      if (!seg) continue
      const key = segKey(ref.sourceId, ref.groupId, sm.id)
      const results: LeafResult[] = cond.conditions.map((leaf, i) => {
        if (leaf.kind === 'inPlace') {
          if (insidePlaceIds === null) return 'na' // 位置不明 → 中立(fail-open)
          const inside = insidePlaceIds.has(leaf.placeId)
          return leaf.outside ? !inside : inside
        }
        if (leaf.kind === 'present') {
          // 同 group 内の対象 segment が live で値を持つか。不在検出が目的なので常に bool(na にしない)。
          const t = group.segments.find((s) => s.id === leaf.seg)
          const has = !!t && t.value.trim() !== ''
          return leaf.absent ? !has : has
        }
        // threshold / onChange: 対象 = peer(leaf.seg 指定時) or self。明示 peer の不在は false
        // (na にすると単独条件で fail-open し「B が満たしたら A」と矛盾する)。
        const target = leaf.seg ? group.segments.find((s) => s.id === leaf.seg) : seg
        if (leaf.kind === 'threshold') {
          if (!target) return false
          return evalThreshold(leaf, target) // percent 欠落は 'na'(self/peer 共通)
        }
        // onChange: 対象不在は変化観測不能 → false。状態キーに対象 id を含め、対象切替直後の誤発火を防ぐ。
        if (!target) return false
        const lkey = `${key}#${i}:${leaf.seg ?? seg.id}`
        const cur = target.value
        const before = prev.get(lkey)
        let activeUntil = before?.activeUntil ?? 0
        if (before && before.prevValue !== cur) activeUntil = now + leaf.holdMs
        states.set(lkey, { prevValue: cur, activeUntil })
        if (activeUntil > now) wakeAt = wakeAt == null ? activeUntil : Math.min(wakeAt, activeUntil)
        return now < activeUntil
      })
      map.set(key, combine(results, cond.combinator))
    }
  }
  return { map, states, wakeAt }
}

// render 側ヘルパ。未指定 map / 未登録 key は全可視 (後方互換)。
export function isVisible(map: VisibleMap | undefined, key: string): boolean {
  return map?.get(key) ?? true
}
