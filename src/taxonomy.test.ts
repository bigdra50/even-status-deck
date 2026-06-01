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
})

test('defaultCategory: place group の here は place_geofence, 動的地点は place_distance', () => {
  // 統合 client.location の place group(地名+標高+保存地点ナビ)。実 group id を config から pin する。
  expect(LOCATION_PLACE_GROUP_ID).toBe('place')
  expect(defaultCategory(LOCATION_PLACE_GROUP_ID, 'here')).toBe('place_geofence')
  expect(defaultCategory(LOCATION_PLACE_GROUP_ID, 'pl_abc12345')).toBe('place_distance') // 保存地点 id(pl_ 前置)
})

test('defaultCategory: 未知 group/segment は custom', () => {
  expect(defaultCategory('unknown', 'whatever')).toBe('custom')
  expect(defaultCategory('weather', 'nonexistent')).toBe('custom')
})
