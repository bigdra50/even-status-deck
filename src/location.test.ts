// 統合 client source "Location" producer の構造契約テスト。実行: bun test src/location.test.ts
// 内部 4 producer(weather/air/geocode/geoinfo)は geolocation/fetch に依存するため、test 環境
// (navigator なし)では各々が error doc に degrade する。
// ここでは「2 group(weather/place)へ再編して 1 doc を返す」骨格と abort 挙動を検証する
// (整形ロジックは weather/geocode 等の個別テストが担う)。
import { expect, test } from 'bun:test'
import { LOCATION_PLACE_GROUP_ID, LOCATION_WEATHER_GROUP_ID } from './config'
import { locationStatus } from './location'

test('locationStatus: 2 group(weather/place)に再編して 1 doc を返す', async () => {
  const doc = await locationStatus(new AbortController().signal)
  expect(doc).not.toBeNull()
  expect(doc?.groups.map((g) => g.id)).toEqual([LOCATION_WEATHER_GROUP_ID, LOCATION_PLACE_GROUP_ID])
  expect(doc?.groups.map((g) => g.label)).toEqual(['Weather', 'Place'])
})

test('locationStatus: abort 済み signal は null を返す', async () => {
  const ac = new AbortController()
  ac.abort()
  expect(await locationStatus(ac.signal)).toBeNull()
})
