// geoinfo.ts の純粋ロジック (整形/単位/doc 組立/URL)。geolocation/fetch はブラウザ依存で除外。
// 実行: bun test src/geoinfo.test.ts
import { expect, test } from 'bun:test'
import {
  buildGeoinfoDoc,
  DEFAULT_GEOINFO_OPTIONS,
  elevationUrl,
  GEOINFO_GROUP_ID,
  type GeoinfoReading,
  metersToFeet,
  readGeoinfoOptions,
  tzCity,
  tzOffsetLabel,
  tzUrl,
} from './geoinfo'

test('metersToFeet: 100m ≒ 328ft', () => {
  expect(Math.round(metersToFeet(100))).toBe(328)
  expect(Math.round(metersToFeet(0))).toBe(0)
})

test('tzCity: IANA 名の末尾地名を ASCII で(_ は空白)', () => {
  expect(tzCity('Asia/Tokyo')).toBe('Tokyo')
  expect(tzCity('America/New_York')).toBe('New York')
  expect(tzCity('Europe/Paris')).toBe('Paris')
  expect(tzCity('UTC')).toBe('UTC')
})

test('tzOffsetLabel: 秒オフセットを UTC±H[:MM] へ', () => {
  expect(tzOffsetLabel(9 * 3600)).toBe('UTC+9')
  expect(tzOffsetLabel(0)).toBe('UTC+0')
  expect(tzOffsetLabel(-3 * 3600)).toBe('UTC-3')
  expect(tzOffsetLabel(5.5 * 3600)).toBe('UTC+5:30') // インド
  expect(tzOffsetLabel(-(3 * 3600 + 30 * 60))).toBe('UTC-3:30') // ニューファンドランド
})

test('readGeoinfoOptions: 既定 m、ft は採用、不正は m', () => {
  expect(readGeoinfoOptions(undefined)).toEqual({ elevUnit: 'm' })
  expect(readGeoinfoOptions({ elevUnit: 'ft' })).toEqual({ elevUnit: 'ft' })
  expect(readGeoinfoOptions({ elevUnit: 'parsec' })).toEqual({ elevUnit: 'm' })
})

test('buildGeoinfoDoc: 全 segment は既定 OFF、欠落フィールドは push しない', () => {
  const reading: GeoinfoReading = { elevationM: 38, utcOffsetSec: 9 * 3600, timezone: 'Asia/Tokyo' }
  const g = buildGeoinfoDoc(reading, DEFAULT_GEOINFO_OPTIONS, 1).groups[0]
  expect(g.id).toBe(GEOINFO_GROUP_ID)
  expect(g.label).toBe('Location')
  const byId = new Map(g.segments.map((s) => [s.id, s]))
  expect(byId.get('elev')?.value).toBe('38m')
  expect(byId.get('tz')?.value).toBe('UTC+9')
  expect(byId.get('zone')?.value).toBe('Tokyo')
  for (const id of ['elev', 'tz', 'zone']) expect(byId.get(id)?.defaultEnabled).toBe(false)
  // 欠落フィールドは出さない
  const partial = buildGeoinfoDoc({ elevationM: 100 }, DEFAULT_GEOINFO_OPTIONS, 1).groups[0]
  expect(partial.segments.map((s) => s.id)).toEqual(['elev'])
})

test('buildGeoinfoDoc: ft オプションで標高が ft 表示になる', () => {
  const byId = new Map(
    buildGeoinfoDoc({ elevationM: 1000 }, { elevUnit: 'ft' }, 1).groups[0].segments.map((s) => [
      s.id,
      s.value,
    ]),
  )
  expect(byId.get('elev')).toBe('3281ft') // 1000m
})

test('buildGeoinfoDoc: state/message を載せられる (stale/error)', () => {
  const doc = buildGeoinfoDoc({ elevationM: 38 }, DEFAULT_GEOINFO_OPTIONS, 1, 'stale', 'cached')
  expect(doc.groups[0].state).toBe('stale')
  expect(doc.groups[0].message).toBe('cached')
})

test('elevationUrl / tzUrl: host は api.open-meteo.com 固定 + 丸め座標', () => {
  const e = new URL(elevationUrl(35.68, 139.61))
  expect(e.host).toBe('api.open-meteo.com')
  expect(e.pathname).toBe('/v1/elevation')
  expect(e.searchParams.get('latitude')).toBe('35.68')
  const t = new URL(tzUrl(35.68, 139.61))
  expect(t.host).toBe('api.open-meteo.com')
  expect(t.pathname).toBe('/v1/forecast')
  expect(t.searchParams.get('timezone')).toBe('auto')
})
