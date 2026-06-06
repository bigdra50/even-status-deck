// geofence(#43) 位置/圏内モジュールの単体テスト。距離/方位ナビ(#42)撤廃後の契約。
// 距離計算の純ロジックは geo.test.ts、preset 提案は suggest.test.ts が担う。ここは
// 「保存地点が無ければ位置を取らない」「現在地キャッシュ更新後に圏内判定できる」を検証する。
// 実行: bun test src/places.test.ts
import { afterAll, expect, test } from 'bun:test'
import type { Place } from './config'
import {
  getCurrentPlaceId,
  getInsidePlaceIds,
  refreshGeofencePosition,
  setSavedPlaces,
} from './places'

const tokyo: Place = { id: 'pl_tokyo', label: 'Tokyo', lat: 35.681, lon: 139.767 }

type GeoOk = (p: { coords: { latitude: number; longitude: number } }) => void

// navigator.geolocation.getCurrentPosition をモックする。null で navigator を外す。
function setGeo(pos: { lat: number; lon: number } | null): void {
  const g = globalThis as { navigator?: { geolocation: { getCurrentPosition: unknown } } }
  if (!pos) {
    delete g.navigator
    return
  }
  g.navigator = {
    geolocation: {
      getCurrentPosition: (ok: GeoOk) => ok({ coords: { latitude: pos.lat, longitude: pos.lon } }),
    },
  }
}

// モックは process 共有の globalThis に載るため、後続テストファイル(location.test.ts 等の
// 「navigator 不在で即 degrade」前提)へリークしないよう必ず外す。
afterAll(() => setGeo(null))

// 注: lastPos はモジュール singleton。以下のテストは順に実行され、各々が refresh で lastPos を確定させる。
test('refreshGeofencePosition: 保存地点が無ければ位置を取らない(getCurrentPlaceId は null)', async () => {
  setGeo(null) // navigator 無し: 呼ばれたら reject するが、early return で触れない
  setSavedPlaces([])
  await refreshGeofencePosition(new AbortController().signal)
  expect(getCurrentPlaceId()).toBeNull()
  expect(getInsidePlaceIds()).toBeNull() // lastPos 未確定
})

test('refreshGeofencePosition: 現在地が圏内なら getCurrentPlaceId / getInsidePlaceIds が地点を返す', async () => {
  setSavedPlaces([tokyo])
  setGeo({ lat: tokyo.lat, lon: tokyo.lon }) // 地点ど真ん中=圏内
  await refreshGeofencePosition(new AbortController().signal)
  expect(getCurrentPlaceId()).toBe('pl_tokyo')
  expect(getInsidePlaceIds()?.has('pl_tokyo')).toBe(true)
})

test('refreshGeofencePosition: 現在地が圏外なら getCurrentPlaceId は null(圏内集合は空)', async () => {
  setSavedPlaces([tokyo])
  setGeo({ lat: 0, lon: 0 }) // 赤道沖=圏外
  await refreshGeofencePosition(new AbortController().signal)
  expect(getCurrentPlaceId()).toBeNull()
  expect(getInsidePlaceIds()?.size).toBe(0) // lastPos は fresh だが圏内 0 件
})

test('refreshGeofencePosition: abort 済み signal は lastPos を更新しない', async () => {
  setSavedPlaces([tokyo])
  setGeo({ lat: tokyo.lat, lon: tokyo.lon })
  const ac = new AbortController()
  ac.abort()
  await refreshGeofencePosition(ac.signal)
  expect(getCurrentPlaceId()).toBeNull() // 直前テストの圏外位置が保持され、東京は圏内にならない
})
