// geofence(#43) の現在地追跡 + 圏内判定モジュール。保存地点(Config.places)に対する現在地ベースの
// 圏内判定を提供する。距離/方位ナビ表示(#42)は撤廃済(place 表示を全廃・geofence のみ存続)。
// 表示 segment は一切返さない=純粋に lastPos キャッシュと圏内クエリのみ。
// 位置取得は Location source の poll(locationStatus)から refreshGeofencePosition 経由で行う(opt-in 連動)。
//
// 保存地点リストは store が setSavedPlaces で供給する(このモジュールは config を直接参照しない=循環 import 回避)。
import type { Place } from './config'
import { DEFAULT_PLACE_RADIUS_M } from './config'
import { placesInRange } from './geo'

const GEO_TIMEOUT_MS = 10_000
const GEO_MAX_AGE_MS = 120_000 // geofence は現在地の鮮度が要るので OS 位置キャッシュは 2 分まで
const STALE_MAX_MS = 10 * 60_000 // 位置取得失敗時に直近位置で圏内判定してよい上限

// 保存地点リスト。store が setSourcesFromConfig 時に setSavedPlaces で供給する(このモジュールは config 非参照)。
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

// 直近の現在地(in-memory)。位置取得失敗時に短時間は直近位置で圏内判定を続ける(stale)。reload で消える。
let lastPos: { lat: number; lon: number; at: number } | null = null
const FAIL_BACKOFF_MS = 2 * 60_000
let lastFailAt = 0

// ジオフェンス: 現在地が圏内の保存地点 id 集合(#43)。位置不明/stale は null(visibility は fail-open=na)。
// visibility/runtime が inPlace leaf 評価で読む。
export function getInsidePlaceIds(): Set<string> | null {
  if (!lastPos || Date.now() - lastPos.at > STALE_MAX_MS) return null
  return new Set(placesInRange(lastPos, savedPlaces, DEFAULT_PLACE_RADIUS_M).map((x) => x.id))
}

// 現在地の代表ジオフェンス地点 id(最も近い圏内, #43 preset 提案/自動切替用)。圏外/位置不明/stale は null。
export function getCurrentPlaceId(): string | null {
  if (!lastPos || Date.now() - lastPos.at > STALE_MAX_MS) return null
  return placesInRange(lastPos, savedPlaces, DEFAULT_PLACE_RADIUS_M)[0]?.id ?? null
}

// geofence 用の現在地キャッシュ(lastPos)を更新する副作用関数。表示 doc は返さない。
// Location source の poll(locationStatus)から呼ばれる=位置取得は source の opt-in に連動する。
// - 保存地点が無ければ位置を取らない(permission/電池の無駄を避ける)。
// - 直近失敗の backoff 中は skip(直近 lastPos を STALE_MAX_MS 窓で使い続ける)。
// - reject は内部で握り、呼び出し元(locationStatus)を巻き込まない。
export async function refreshGeofencePosition(signal: AbortSignal): Promise<void> {
  if (savedPlaces.length === 0) return
  const now = Date.now()
  if (now - lastFailAt < FAIL_BACKOFF_MS) return // backoff 中: 直近位置を stale 窓で使う
  try {
    const pos = await getPosition()
    if (signal.aborted) return
    lastPos = { lat: pos.lat, lon: pos.lon, at: now }
    lastFailAt = 0
  } catch (err) {
    if (signal.aborted) return
    lastFailAt = now
    console.warn(`[geofence] ${err instanceof Error ? err.message : 'location unavailable'}`)
  }
}
