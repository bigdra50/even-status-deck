// 統合 client source "Location" の producer。位置由来の 4 producer(weather/airquality/geocode/geoinfo)を
// 呼び、結果を 2 group(weather=気象+大気質 / place=地名+標高/TZ)へ再編して 1 StatusDoc を返す。
// 併せて geofence(#43) 用の現在地キャッシュを refreshGeofencePosition で更新する(表示なし副作用)。
// store.refreshSource(kind==='client') から poll ごとに呼ばれる。
//
// 設計(codex 3往復で確定): source 5→1・group 2 への集約。距離/方位ナビ表示(#42)は撤廃済(place 表示を
// 全廃し geofence のみ存続)。geofence の位置追跡は Location source の poll に連動する(opt-in)。
// - geolocation は各 producer が getCurrentPosition(maximumAge で OS キャッシュ)を使うため、許可ダイアログは
//   実質 1 回。各 producer は独自 TTL/backoff を内部に持つ(更新頻度: weather/air 30分・geoinfo 6時間 等)。
// - health は per-segment: 各 producer の group.state を、その group の全 segment の Segment.state へ焼く
//   (open-meteo は生きてるが bigdatacloud が死ぬ等を segment 単位で表現)。
// - group.state は派生(default-visible=primary segment の最悪状態)。既定 OFF の air の error に
//   weather group 全体が引きずられないようにする。
import { airqualityStatus } from './airquality'
import type { OptionValues } from './config'
import { LOCATION_PLACE_GROUP_ID, LOCATION_WEATHER_GROUP_ID } from './config'
import { geocodeStatus } from './geocode'
import { geoinfoStatus } from './geoinfo'
import { refreshGeofencePosition } from './places'
import type { Group, Segment, SourceState, StatusDoc } from './status-types'
import { weatherStatus } from './weather'

// doc(単一 group)から segment を取り出し、group.state を各 segment へ焼く(per-source → per-segment health)。
// doc が null(abort/不可)なら空。state が 'ok' の segment は素通し(余計な state を付けない)。
function takeSegments(doc: StatusDoc | null): Segment[] {
  const g = doc?.groups[0]
  if (!g) return []
  const st = g.state
  if (!st || st === 'ok') return g.segments
  return g.segments.map((s) => ({
    ...s,
    state: s.state ?? st,
    message: s.message ?? g.message,
  }))
}

function worstState(states: (SourceState | undefined)[]): SourceState | undefined {
  if (states.includes('error')) return 'error'
  if (states.includes('stale')) return 'stale'
  return undefined
}

// group.state を「primary(defaultEnabled)segment の最悪状態」で派生する。
// primary が無ければ全 segment で評価。既定 OFF の補助 segment(air)の error で group が赤くならない。
function applyDerivedGroupState(g: Group): void {
  const primary = g.segments.filter((s) => s.defaultEnabled)
  const pool = primary.length ? primary : g.segments
  const st = worstState(pool.map((s) => s.state))
  if (st) g.state = st
}

export async function locationStatus(
  signal: AbortSignal,
  options?: OptionValues,
): Promise<StatusDoc | null> {
  // 5 つ目は geofence 用 lastPos 更新の副作用(void)。表示には使わない。
  const [weather, air, geocode, geoinfo] = await Promise.all([
    weatherStatus(signal, options),
    airqualityStatus(signal, options),
    geocodeStatus(signal, options),
    geoinfoStatus(signal, options),
    refreshGeofencePosition(signal),
  ])
  if (signal.aborted) return null
  const ts = Date.now()

  const weatherGroup: Group = {
    id: LOCATION_WEATHER_GROUP_ID,
    label: 'Weather',
    segments: [...takeSegments(weather), ...takeSegments(air)],
  }
  // suncountdown(#38)の anchors は weather group から引き継ぐ(glass が毎分再計算する)。
  const anchors = weather?.groups[0]?.anchors
  if (anchors) weatherGroup.anchors = anchors

  const placeGroup: Group = {
    id: LOCATION_PLACE_GROUP_ID,
    label: 'Place',
    segments: [...takeSegments(geocode), ...takeSegments(geoinfo)],
  }

  applyDerivedGroupState(weatherGroup)
  applyDerivedGroupState(placeGroup)
  return { version: 1, ts, groups: [weatherGroup, placeGroup] }
}
