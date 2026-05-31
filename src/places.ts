// client source: 保存地点(Config.places)までの距離・方位を現在地から計算して places(nav) group を返す(#42)。
// 外部 fetch は無し(geolocation + Config.places から純計算)。**座標を外部送信しない**ため round2 で丸めず
// フル精度で距離計算する(PII リスク無し・近距離の精度向上)。値は ASCII のみ(方位の矢印グリフは opt-in)。
//
// 保存地点リストは store が setSavedPlaces で供給する(producer は config を直接参照しない=循環 import 回避)。
import type { OptionValues, Place } from './config'
import { DEFAULT_PLACE_RADIUS_M, PLACES_GROUP_ID } from './config'
import {
  type BearingStyle,
  bearingDeg,
  type DistanceUnit,
  formatBearing,
  formatDistance,
  haversineKm,
  placesInRange,
} from './geo'
import type { Group, Segment, SourceState, StatusDoc } from './status-types'

const GEO_TIMEOUT_MS = 10_000
const GEO_MAX_AGE_MS = 120_000 // ナビは現在地の鮮度が要るので OS 位置キャッシュは 2 分まで(weather は 30 分)
const STALE_MAX_MS = 10 * 60_000 // 位置取得失敗時に直近位置で計算してよい上限

export type PlacesOptions = { distUnit: DistanceUnit; bearingStyle: BearingStyle }
export const DEFAULT_PLACES_OPTIONS: PlacesOptions = { distUnit: 'km', bearingStyle: 'text' }

export function readPlacesOptions(bag: OptionValues | undefined): PlacesOptions {
  const unit = bag?.distUnit
  const style = bag?.bearingStyle
  return {
    distUnit: unit === 'mi' ? 'mi' : 'km',
    bearingStyle: style === 'arrow' ? 'arrow' : style === 'compass16' ? 'compass16' : 'text',
  }
}

// 文字列を ASCII へ畳む(地点ラベルはユーザー入力。アクセント/CJK の tofu を避ける)。
function asciiFold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^ -~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type NavItem = { id: string; label: string; value: string }

// 現在地から各保存地点への距離・方位を計算する(純関数)。距離昇順で返す(近い順)。
export function computeNav(
  places: Place[],
  pos: { lat: number; lon: number },
  opts: PlacesOptions,
): NavItem[] {
  return places
    .map((p) => {
      const km = haversineKm(pos.lat, pos.lon, p.lat, p.lon)
      const deg = bearingDeg(pos.lat, pos.lon, p.lat, p.lon)
      return {
        id: p.id,
        label: asciiFold(p.label) || 'Place',
        value: `${formatDistance(km, opts.distUnit)} ${formatBearing(deg, opts.bearingStyle)}`,
        km,
      }
    })
    .sort((a, b) => a.km - b.km)
    .map(({ id, label, value }) => ({ id, label, value }))
}

// nav item 群から places group の StatusDoc を組む。各保存地点 = 1 segment(既定 ON=ユーザーが明示追加したもの)。
// hereValue(現在ジオフェンス圏内の地点名 or 'Away', #43)が与えられたら先頭に here segment(既定 OFF)を足す。
export function buildPlacesDoc(
  items: NavItem[],
  hereValue: string | undefined,
  ts: number,
  state?: SourceState,
  message?: string,
): StatusDoc {
  const segments: Segment[] = []
  if (hereValue !== undefined) {
    segments.push({ id: 'here', label: 'At', value: hereValue, defaultEnabled: false, widthChars: 12 })
  }
  for (const it of items) {
    segments.push({ id: it.id, label: it.label, value: it.value, defaultEnabled: true, widthChars: 10 })
  }
  const group: Group = { id: PLACES_GROUP_ID, label: 'Places', segments }
  if (state) group.state = state
  if (message) group.message = message
  return { version: 1, ts, groups: [group] }
}

// 保存地点リスト。store が setSourcesFromConfig 時に setSavedPlaces で供給する(producer は config 非参照)。
let savedPlaces: Place[] = []
export function setSavedPlaces(places: Place[]): void {
  savedPlaces = places.map((p) => ({ ...p }))
}

function getPosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('geolocation unavailable'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(`geolocation error ${e.code}: ${e.message}`)),
      { enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: GEO_MAX_AGE_MS },
    )
  })
}

// 直近の現在地(in-memory)。位置取得失敗時に短時間は直近位置で計算を続ける(stale)。reload で消える。
let lastPos: { lat: number; lon: number; at: number } | null = null
const FAIL_BACKOFF_MS = 2 * 60_000
let lastFailAt = 0

// 現在ジオフェンス圏内の地点名(最も近い圏内, #43)。圏外なら 'Away'。here segment value 用。
function hereLabelFor(places: Place[], pos: { lat: number; lon: number }): string {
  const id = placesInRange(pos, places, DEFAULT_PLACE_RADIUS_M)[0]?.id
  const p = id ? places.find((x) => x.id === id) : undefined
  return p ? asciiFold(p.label) || 'Place' : 'Away'
}

// ジオフェンス: 現在地が圏内の保存地点 id 集合(#43)。位置不明/stale は null(visibility は fail-open=na)。
// visibility/runtime が inPlace leaf 評価で読む(places の lastPos を介する=独立した geolocation を増やさない)。
// 現在地代表 place の preset 自動切替は #43 follow-up(getCurrentPlaceId は実装時に再追加)。
export function getInsidePlaceIds(): Set<string> | null {
  if (!lastPos || Date.now() - lastPos.at > STALE_MAX_MS) return null
  return new Set(placesInRange(lastPos, savedPlaces, DEFAULT_PLACE_RADIUS_M).map((x) => x.id))
}

// client source の producer。保存地点が無ければ空 group。あれば現在地を取り距離・方位を計算する。
export async function placesStatus(
  signal: AbortSignal,
  options?: OptionValues,
): Promise<StatusDoc | null> {
  const opts = readPlacesOptions(options)
  const now = Date.now()
  const places = savedPlaces
  if (places.length === 0) return buildPlacesDoc([], undefined, now) // 地点未登録: 空 group
  // 直近失敗の backoff 中は直近位置で計算 or error degrade。
  if (now - lastFailAt < FAIL_BACKOFF_MS && lastPos && now - lastPos.at < STALE_MAX_MS) {
    const p = lastPos
    return buildPlacesDoc(computeNav(places, p, opts), hereLabelFor(places, p), now, 'stale', 'using last position')
  }
  try {
    const pos = await getPosition()
    if (signal.aborted) return null
    lastPos = { lat: pos.lat, lon: pos.lon, at: now }
    lastFailAt = 0
    return buildPlacesDoc(computeNav(places, pos, opts), hereLabelFor(places, pos), now)
  } catch (err) {
    if (signal.aborted) return null
    lastFailAt = now
    const msg = err instanceof Error ? err.message : 'location unavailable'
    console.warn(`[places] ${msg}`)
    if (lastPos && now - lastPos.at < STALE_MAX_MS) {
      const p = lastPos
      return buildPlacesDoc(computeNav(places, p, opts), hereLabelFor(places, p), now, 'stale', 'using last position')
    }
    const group: Group = {
      id: PLACES_GROUP_ID,
      label: 'Places',
      state: 'error',
      message: msg,
      segments: [],
    }
    return { version: 1, ts: now, groups: [group] }
  }
}
