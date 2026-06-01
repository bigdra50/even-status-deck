// defaultCategory の単体テスト (表示モデル Phase1)。実行: bun test src/taxonomy.test.ts
import { expect, test } from 'bun:test'
// 実 group id を config から引いて pin する (taxonomy 本体は循環回避で literal 'nav' を持つため、
// producer 側の PLACES_GROUP_ID が変わったら検知できるようテストだけが config に依存する)。
import { PLACES_GROUP_ID } from './config'
import { defaultCategory } from './taxonomy'

test('defaultCategory: 既知 segment は device_class leaf を返す', () => {
  expect(defaultCategory('g2', 'level')).toBe('battery')
  expect(defaultCategory('system', 'battery')).toBe('battery') // グラス電池と同 leaf (衝突源)
  expect(defaultCategory('weather', 'temp')).toBe('temperature')
  expect(defaultCategory('weather', 'sunrise')).toBe('sunrise')
  expect(defaultCategory('codex', '5h')).toBe('usage_percent')
  expect(defaultCategory('geocode', 'country')).toBe('place_country')
  expect(defaultCategory('airquality', 'pm25')).toBe('pm25')
})

test('defaultCategory: places(実 group id=nav) の here は place_geofence, 動的地点は place_distance', () => {
  // 実 group id を使う。リテラル 'places' を渡すと group id 不一致バグを温存するため使わない。
  expect(PLACES_GROUP_ID).toBe('nav') // producer (places.ts) と taxonomy のキー整合を pin
  expect(defaultCategory(PLACES_GROUP_ID, 'here')).toBe('place_geofence')
  expect(defaultCategory(PLACES_GROUP_ID, 'pl_abc12345')).toBe('place_distance') // 保存地点 id(pl_ 前置)
})

test('defaultCategory: 未知 group/segment は custom', () => {
  expect(defaultCategory('unknown', 'whatever')).toBe('custom')
  expect(defaultCategory('weather', 'nonexistent')).toBe('custom')
})
