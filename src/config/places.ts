import { segKey } from '../visibility/keys'
import { DEFAULT_PLACE_RADIUS_M, LOCATION_PLACE_GROUP_ID, LOCATION_SOURCE_ID } from './constants'
import { genPlaceId } from './ids'
import type { Config, Place } from './types'

// 旧地点ナビ source(client.places)の group id (#42)。距離ナビ撤廃後は LOCATION_MERGE_MAP の
// legacy 移行(旧 nav group → place group)でのみ参照する内部定数(export 不要)。
export const PLACES_GROUP_ID = 'nav'
const MAX_PLACES = 16 // 保存地点の上限(glass 行数 + UI が現実的な範囲)
const MAX_PLACE_LABEL = 24
const MIN_PLACE_RADIUS_M = 20
const MAX_PLACE_RADIUS_M = 50_000

export function clampRadius(r: unknown): number {
  if (typeof r !== 'number' || !Number.isFinite(r)) return DEFAULT_PLACE_RADIUS_M
  return Math.min(MAX_PLACE_RADIUS_M, Math.max(MIN_PLACE_RADIUS_M, Math.round(r)))
}

// 保存地点配列を sanitize する(壊れた places でクラッシュさせない)。id/label/緯度経度を検証し、上限で切る。
export function normalizePlaces(cfg: Config): void {
  if (!Array.isArray(cfg.places)) {
    cfg.places = []
    return
  }
  const seen = new Set<string>()
  const out: Place[] = []
  for (const p of cfg.places) {
    if (out.length >= MAX_PLACES) break
    if (!p || typeof p !== 'object') continue
    const id = typeof p.id === 'string' ? p.id : ''
    const label = typeof p.label === 'string' ? p.label.slice(0, MAX_PLACE_LABEL) : ''
    const lat = p.lat
    const lon = p.lon
    if (!id || seen.has(id)) continue
    if (
      typeof lat !== 'number' ||
      typeof lon !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    )
      continue
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue
    seen.add(id)
    out.push({ id, label: label || 'Place', lat, lon, radiusM: clampRadius(p.radiusM) })
  }
  cfg.places = out
}

// 保存地点 CRUD (companion から呼ぶ)。素材 segment は producer の status sync が補充するので、ここでは
// places 配列のみ操作する。削除時だけ素材/view に残る孤立 segment を掃除する。
export function addPlace(cfg: Config, label: string, lat: number, lon: number): Place {
  cfg.places ??= []
  const place: Place = {
    id: genPlaceId(),
    label: label.slice(0, MAX_PLACE_LABEL) || 'Place',
    lat,
    lon,
    radiusM: DEFAULT_PLACE_RADIUS_M,
  }
  cfg.places.push(place)
  return place
}

export function renamePlace(cfg: Config, id: string, label: string): boolean {
  const p = cfg.places?.find((x) => x.id === id)
  if (!p) return false
  p.label = label.slice(0, MAX_PLACE_LABEL) || 'Place'
  return true
}

// ジオフェンス半径(m)を設定する(#43)。範囲外は clamp。
export function setPlaceRadius(cfg: Config, id: string, radiusM: number): boolean {
  const p = cfg.places?.find((x) => x.id === id)
  if (!p) return false
  p.radiusM = clampRadius(radiusM)
  return true
}

export function updatePlaceLocation(cfg: Config, id: string, lat: number, lon: number): boolean {
  const p = cfg.places?.find((x) => x.id === id)
  if (!p || !Number.isFinite(lat) || !Number.isFinite(lon)) return false
  p.lat = lat
  p.lon = lon
  return true
}

export function removePlace(cfg: Config, id: string): boolean {
  if (!cfg.places) return false
  const before = cfg.places.length
  cfg.places = cfg.places.filter((p) => p.id !== id)
  if (cfg.places.length === before) return false
  // 孤立 segment を掃除する(素材 + 全 profile view + glassLayout 配置)。さもないと削除後に
  // layout editor が glassLayout.rows の stale chip を描き続ける(discardSource と同じ理由)。
  // 保存地点 segment は統合後 client.location の 'place' group 配下(旧 client.places|nav から畳み済)。
  const key = segKey(LOCATION_SOURCE_ID, LOCATION_PLACE_GROUP_ID, id)
  const meta = cfg.groups[LOCATION_SOURCE_ID]?.[LOCATION_PLACE_GROUP_ID]
  if (meta) meta.segments = meta.segments.filter((s) => s.id !== id)
  for (const prof of cfg.profiles) {
    const vg = prof.view.groups[LOCATION_SOURCE_ID]?.[LOCATION_PLACE_GROUP_ID]
    if (vg) delete vg.segments[id]
    const lay = prof.view.glassLayout
    if (lay) lay.rows = lay.rows.map((row) => row.filter((k) => k !== key))
    // explicit デッキ各ページからも削除 place chip を除去 (dangling 防止)。
    for (const page of prof.view.pages ?? []) {
      page.layout.rows = page.layout.rows.map((row) => row.filter((k) => k !== key))
    }
    // 削除 place に bind された preset の geofence 連動も外す(#43。dangling 参照を残さない)。
    if (prof.geofence?.placeId === id) prof.geofence = undefined
  }
  // 全 segment の visibility から、削除 place を参照する inPlace leaf を除去する(#43)。残すと「At place:
  // <deleted>」条件が常に圏外扱い(insidePlaceIds.has(deletedId)=false)になり segment が予期せず消え、
  // editor の place select も誤表示になる。条件が空になったら visibility ごと外す(=常時表示へ戻す)。
  for (const groups of Object.values(cfg.groups)) {
    for (const m of Object.values(groups)) {
      for (const sm of m.segments) {
        const vis = sm.visibility
        if (!vis) continue
        const kept = vis.conditions.filter((c) => !(c.kind === 'inPlace' && c.placeId === id))
        if (kept.length === vis.conditions.length) continue
        if (kept.length === 0) sm.visibility = undefined
        else vis.conditions = kept
      }
    }
  }
  return true
}
