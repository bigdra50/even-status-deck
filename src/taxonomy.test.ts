// defaultCategory の単体テスト (表示モデル Phase1)。実行: bun test src/taxonomy.test.ts
import { expect, test } from 'bun:test'
// 実 group id を config から引いて pin する (taxonomy 本体は循環回避で literal を持つため、統合先
// group id (place) が変わったら検知できるようテストだけが config に依存する)。
import { LOCATION_PLACE_GROUP_ID } from './config'
import { defaultCategory } from './taxonomy'

test('defaultCategory: 既知 segment は device_class leaf を返す', () => {
  expect(defaultCategory('g2', 'level')).toBe('battery')
  expect(defaultCategory('system', 'battery')).toBe('battery') // グラス電池と同 leaf (衝突源)
  expect(defaultCategory('weather', 'temp')).toBe('temperature')
  expect(defaultCategory('weather', 'sunrise')).toBe('sunrise')
  expect(defaultCategory('codex', '5h')).toBe('usage_percent')
  // 統合後: 地名(旧 geocode)・大気質(旧 airquality)は group 'weather'/'place' へ畳まれている。
  expect(defaultCategory('place', 'country')).toBe('place_country') // 旧 geocode|country
  expect(defaultCategory('weather', 'pm25')).toBe('pm25') // 旧 airquality|pm25
  // place group は地名(city/area/region/country)+標高/TZ(elev/tz/zone)のみ。実 group id を pin。
  expect(LOCATION_PLACE_GROUP_ID).toBe('place')
  expect(defaultCategory(LOCATION_PLACE_GROUP_ID, 'elev')).toBe('elevation')
})

test('defaultCategory: 距離ナビ撤廃後、pl_xxxx/here は custom(place_distance/place_geofence は廃止)', () => {
  // 距離/方位ナビ(#42)撤廃: place group の動的 segment(pl_xxxx)と presence(here)は分類対象外。
  expect(defaultCategory(LOCATION_PLACE_GROUP_ID, 'here')).toBe('custom')
  expect(defaultCategory(LOCATION_PLACE_GROUP_ID, 'pl_abc12345')).toBe('custom')
})

test('defaultCategory: 未知 group/segment は custom', () => {
  expect(defaultCategory('unknown', 'whatever')).toBe('custom')
  expect(defaultCategory('weather', 'nonexistent')).toBe('custom')
})
