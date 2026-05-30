// weather.ts の純粋ロジック (weatherCodeText / buildWeatherDoc)。geolocation/fetch はブラウザ依存で除外。
// 実行: bun test src/weather.test.ts
import { expect, test } from 'bun:test'
import { buildWeatherDoc, WEATHER_GROUP_ID, weatherCodeText } from './weather'

test('weatherCodeText: WMO code を短い ASCII ラベルへ', () => {
  expect(weatherCodeText(0)).toBe('Clear')
  expect(weatherCodeText(1)).toBe('Clear')
  expect(weatherCodeText(2)).toBe('Cloudy')
  expect(weatherCodeText(3)).toBe('Overcast')
  expect(weatherCodeText(45)).toBe('Fog')
  expect(weatherCodeText(48)).toBe('Fog')
  expect(weatherCodeText(55)).toBe('Drizzle')
  expect(weatherCodeText(63)).toBe('Rain')
  expect(weatherCodeText(75)).toBe('Snow')
  expect(weatherCodeText(86)).toBe('Snow')
  expect(weatherCodeText(81)).toBe('Showers')
  expect(weatherCodeText(95)).toBe('Storm')
  expect(weatherCodeText(99)).toBe('Storm')
  expect(weatherCodeText(123)).toBe('Wx') // 未知コード
})

test('buildWeatherDoc: weather group を temp/cond/wind で組む', () => {
  const doc = buildWeatherDoc(12.4, 2, 18.6, 1000)
  expect(doc.groups).toHaveLength(1)
  const g = doc.groups[0]
  expect(g.id).toBe(WEATHER_GROUP_ID)
  expect(g.label).toBe('Weather')
  const byId = new Map(g.segments.map((s) => [s.id, s]))
  expect(byId.get('temp')?.value).toBe('12°C')
  expect(byId.get('cond')?.value).toBe('Cloudy')
  expect(byId.get('wind')?.value).toBe('19km/h')
  expect(byId.get('temp')?.defaultEnabled).toBe(true)
  expect(byId.get('wind')?.defaultEnabled).toBe(false) // wind は既定 OFF
})

test('buildWeatherDoc: state/message を載せられる (stale/error 表示用)', () => {
  const doc = buildWeatherDoc(0, 0, 0, 1, 'stale', 'using cached weather')
  expect(doc.groups[0].state).toBe('stale')
  expect(doc.groups[0].message).toBe('using cached weather')
})
