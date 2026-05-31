// geocode.ts の純粋ロジック (asciiFold/doc 組立/URL)。geolocation/fetch は除外。
// 実行: bun test src/geocode.test.ts
import { expect, test } from 'bun:test'
import {
  asciiFold,
  buildGeocodeDoc,
  GEOCODE_GROUP_ID,
  type GeocodeReading,
  geocodeUrl,
} from './geocode'

test('asciiFold: アクセント除去・非 ASCII 空白化', () => {
  expect(asciiFold('Paris')).toBe('Paris')
  expect(asciiFold('São Paulo')).toBe('Sao Paulo')
  expect(asciiFold('Zürich')).toBe('Zurich')
  expect(asciiFold('Île-de-France')).toBe('Ile-de-France')
  expect(asciiFold('東京')).toBe('') // CJK は畳めず空白化 → trim で空
  expect(asciiFold('Tokyo 東京')).toBe('Tokyo') // 混在は ASCII 部のみ
})

test('buildGeocodeDoc: city は既定 ON、他は既定 OFF、値は asciiFold 済み', () => {
  const reading: GeocodeReading = {
    city: 'São Paulo',
    area: 'Vila Mariana',
    region: 'São Paulo',
    country: 'Brazil',
  }
  const g = buildGeocodeDoc(reading, undefined, 1).groups[0]
  expect(g.id).toBe(GEOCODE_GROUP_ID)
  expect(g.label).toBe('Place')
  const byId = new Map(g.segments.map((s) => [s.id, s]))
  expect(byId.get('city')?.value).toBe('Sao Paulo') // asciiFold
  expect(byId.get('city')?.defaultEnabled).toBe(true)
  expect(byId.get('area')?.value).toBe('Vila Mariana')
  expect(byId.get('area')?.defaultEnabled).toBe(false)
  expect(byId.get('region')?.value).toBe('Sao Paulo')
  expect(byId.get('country')?.value).toBe('Brazil')
})

test('buildGeocodeDoc: 欠落フィールドは push しない', () => {
  const byId = new Map(
    buildGeocodeDoc({ city: 'Paris', country: 'France' }, undefined, 1).groups[0].segments.map(
      (s) => [s.id, s],
    ),
  )
  expect(byId.get('city')?.value).toBe('Paris')
  expect(byId.has('area')).toBe(false)
  expect(byId.has('region')).toBe(false)
  expect(byId.get('country')?.value).toBe('France')
})

test('buildGeocodeDoc: state/message を載せられる (stale/error)', () => {
  const doc = buildGeocodeDoc({ city: 'Paris' }, undefined, 1, 'stale', 'cached')
  expect(doc.groups[0].state).toBe('stale')
})

test('geocodeUrl: host は api.bigdatacloud.net + 丸め座標 + en', () => {
  const u = new URL(geocodeUrl(48.85, 2.35))
  expect(u.host).toBe('api.bigdatacloud.net')
  expect(u.pathname).toBe('/data/reverse-geocode-client')
  expect(u.searchParams.get('latitude')).toBe('48.85')
  expect(u.searchParams.get('localityLanguage')).toBe('en')
})
