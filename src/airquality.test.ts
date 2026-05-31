// airquality.ts の純粋ロジック (整形/規格選択/花粉レベル/doc/URL)。geolocation/fetch は除外。
// 実行: bun test src/airquality.test.ts
import { expect, test } from 'bun:test'
import {
  AIRQUALITY_GROUP_ID,
  type AirqualityReading,
  airqualityUrl,
  buildAirqualityDoc,
  DEFAULT_AIRQUALITY_OPTIONS,
  pollenLevel,
  readAirqualityOptions,
} from './airquality'

test('pollenLevel: grains/m³ を ASCII レベルへ', () => {
  expect(pollenLevel(0)).toBe('None')
  expect(pollenLevel(5)).toBe('Low')
  expect(pollenLevel(30)).toBe('Med')
  expect(pollenLevel(120)).toBe('High')
})

test('readAirqualityOptions: 既定 us、eu は採用、不正は us', () => {
  expect(readAirqualityOptions(undefined)).toEqual({ aqiStandard: 'us' })
  expect(readAirqualityOptions({ aqiStandard: 'eu' })).toEqual({ aqiStandard: 'eu' })
  expect(readAirqualityOptions({ aqiStandard: 'jp' })).toEqual({ aqiStandard: 'us' })
})

test('buildAirqualityDoc: aqi は既定 ON、pm/pollen は既定 OFF、規格で値が切替', () => {
  const reading: AirqualityReading = { usAqi: 84, euAqi: 62, pm25: 30, pm10: 33, pollenMax: 40 }
  const usDoc = buildAirqualityDoc(reading, DEFAULT_AIRQUALITY_OPTIONS, 1).groups[0]
  expect(usDoc.id).toBe(AIRQUALITY_GROUP_ID)
  expect(usDoc.label).toBe('Air')
  const us = new Map(usDoc.segments.map((s) => [s.id, s]))
  expect(us.get('aqi')?.value).toBe('84') // US AQI 既定
  expect(us.get('aqi')?.defaultEnabled).toBe(true)
  expect(us.get('pm25')?.value).toBe('30')
  expect(us.get('pm25')?.defaultEnabled).toBe(false)
  expect(us.get('pm10')?.value).toBe('33')
  expect(us.get('pollen')?.value).toBe('Med') // 40 grains
  // EU 規格に切替
  const eu = new Map(
    buildAirqualityDoc(reading, { aqiStandard: 'eu' }, 1).groups[0].segments.map((s) => [
      s.id,
      s.value,
    ]),
  )
  expect(eu.get('aqi')).toBe('62') // EU AQI
})

test('buildAirqualityDoc: 欠落フィールドは push しない(花粉非対応地域は pollen 無し)', () => {
  const byId = new Map(
    buildAirqualityDoc({ usAqi: 50 }, DEFAULT_AIRQUALITY_OPTIONS, 1).groups[0].segments.map((s) => [
      s.id,
      s,
    ]),
  )
  expect(byId.get('aqi')?.value).toBe('50')
  expect(byId.has('pm25')).toBe(false)
  expect(byId.has('pollen')).toBe(false)
})

test('buildAirqualityDoc: 選択規格の AQI が無ければ aqi segment を出さない', () => {
  // EU 規格選択だが euAqi 欠落 → aqi 無し(usAqi はあるが規格不一致なので使わない)
  const byId = new Map(
    buildAirqualityDoc({ usAqi: 84 }, { aqiStandard: 'eu' }, 1).groups[0].segments.map((s) => [
      s.id,
      s,
    ]),
  )
  expect(byId.has('aqi')).toBe(false)
})

test('buildAirqualityDoc: state/message を載せられる (stale/error)', () => {
  const doc = buildAirqualityDoc({ usAqi: 50 }, DEFAULT_AIRQUALITY_OPTIONS, 1, 'stale', 'cached')
  expect(doc.groups[0].state).toBe('stale')
})

test('airqualityUrl: host は air-quality-api.open-meteo.com + 丸め座標 + current パラメータ', () => {
  const u = new URL(airqualityUrl(35.68, 139.61))
  expect(u.host).toBe('air-quality-api.open-meteo.com')
  expect(u.pathname).toBe('/v1/air-quality')
  expect(u.searchParams.get('latitude')).toBe('35.68')
  expect(u.searchParams.get('current')).toContain('us_aqi')
  expect(u.searchParams.get('current')).toContain('european_aqi')
  expect(u.searchParams.get('current')).toContain('grass_pollen')
})
