// places.ts の純粋ロジック(computeNav/buildPlacesDoc/readPlacesOptions)。geolocation は除外。
// 実行: bun test src/places.test.ts
import { expect, test } from 'bun:test'
import type { Place } from './config'
import { PLACES_GROUP_ID } from './config'
import { buildPlacesDoc, computeNav, DEFAULT_PLACES_OPTIONS, readPlacesOptions } from './places'

const places: Place[] = [
  { id: 'pl_far', label: 'Osaka', lat: 34.7, lon: 135.5 },
  { id: 'pl_near', label: 'Shinjuku', lat: 35.69, lon: 139.7 },
]
const tokyo = { lat: 35.681, lon: 139.767 }

test('readPlacesOptions: 既定 km/text、選択値を採用、不正は既定', () => {
  expect(readPlacesOptions(undefined)).toEqual({ distUnit: 'km', bearingStyle: 'text' })
  expect(readPlacesOptions({ distUnit: 'mi', bearingStyle: 'arrow' })).toEqual({
    distUnit: 'mi',
    bearingStyle: 'arrow',
  })
  expect(readPlacesOptions({ distUnit: 'lightyear', bearingStyle: 'x' })).toEqual({
    distUnit: 'km',
    bearingStyle: 'text',
  })
})

test('computeNav: 距離昇順・ラベルfold・距離方位の文字列', () => {
  const nav = computeNav(places, tokyo, DEFAULT_PLACES_OPTIONS)
  expect(nav.map((n) => n.id)).toEqual(['pl_near', 'pl_far']) // 近い順(新宿 < 大阪)
  expect(nav[0].label).toBe('Shinjuku')
  expect(nav[0].value).toMatch(/^[\d.]+km [NESW]+$/) // "6.x km NW" のような形
  expect(nav[1].value).toMatch(/km (SW|WSW|W)/) // 大阪は東京の西〜南西
})

test('computeNav: ラベルの非 ASCII は fold(空なら Place)', () => {
  const nav = computeNav(
    [{ id: 'p', label: '東京', lat: 35.7, lon: 139.7 }],
    tokyo,
    DEFAULT_PLACES_OPTIONS,
  )
  expect(nav[0].label).toBe('Place') // CJK は fold で空 → 'Place'
})

test('computeNav: arrow/mi オプション反映', () => {
  const nav = computeNav([places[1]], tokyo, { distUnit: 'mi', bearingStyle: 'arrow' })
  expect(nav[0].value).toMatch(/mi [↑↗→↘↓↙←↖]$/)
})

test('buildPlacesDoc: 各地点 = 既定 ON segment、空配列は空 group', () => {
  const nav = computeNav(places, tokyo, DEFAULT_PLACES_OPTIONS)
  const g = buildPlacesDoc(nav, undefined, 1).groups[0]
  expect(g.id).toBe(PLACES_GROUP_ID)
  expect(g.label).toBe('Places')
  expect(g.segments).toHaveLength(2)
  expect(g.segments[0].defaultEnabled).toBe(true)
  expect(g.segments[0].id).toBe('pl_near')
  expect(buildPlacesDoc([], undefined, 1).groups[0].segments).toHaveLength(0)
})

test('buildPlacesDoc: here(現在地)segment は既定 OFF で先頭に出る (#43)', () => {
  const g = buildPlacesDoc([], 'Home', 1).groups[0]
  expect(g.segments).toHaveLength(1)
  expect(g.segments[0].id).toBe('here')
  expect(g.segments[0].value).toBe('Home')
  expect(g.segments[0].defaultEnabled).toBe(false)
  // 圏外なら 'Away'
  expect(buildPlacesDoc([], 'Away', 1).groups[0].segments[0].value).toBe('Away')
})

test('buildPlacesDoc: state/message を載せられる (stale)', () => {
  const doc = buildPlacesDoc([], undefined, 1, 'stale', 'using last position')
  expect(doc.groups[0].state).toBe('stale')
})
