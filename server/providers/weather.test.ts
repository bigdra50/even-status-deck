// weather provider (open-meteo) のユニットテスト。global fetch を差し替えて検証する。
// 実行: bun test server/providers/weather.test.ts
import { afterEach, expect, test } from 'bun:test'
import { weatherProvider } from './weather.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

// fetch を固定レスポンスに差し替える。url は capturedUrl に控える。
function stubFetch(body: unknown, init?: { ok?: boolean }) {
  const calls: string[] = []
  globalThis.fetch = ((input: string | URL) => {
    calls.push(input.toString())
    return Promise.resolve({
      ok: init?.ok ?? true,
      json: () => Promise.resolve(body),
    } as Response)
  }) as typeof fetch
  return calls
}

const OK_BODY = {
  current: { temperature_2m: 21.4, weather_code: 0, wind_speed_10m: 4.2 },
  daily: {
    temperature_2m_max: [21.6],
    temperature_2m_min: [13.8],
    precipitation_probability_max: [60],
  },
}

test('座標未設定なら null (group を出さない)', async () => {
  const calls = stubFetch(OK_BODY)
  expect(await weatherProvider({ options: {} })).toBeNull()
  expect(await weatherProvider({ options: { latitude: 35.68 } })).toBeNull()
  // fetch すら呼ばない。
  expect(calls.length).toBe(0)
})

test('座標ありで気温/天気/最高最低/降水/風 segment を返す', async () => {
  stubFetch(OK_BODY)
  const g = await weatherProvider({
    options: { latitude: 35.68, longitude: 139.69, label: 'Tokyo' },
  })
  expect(g).not.toBeNull()
  expect(g?.id).toBe('weather')
  expect(g?.label).toBe('Tokyo')
  const byId = Object.fromEntries((g?.segments ?? []).map((s) => [s.id, s]))
  expect(byId.temp.value).toBe('21° Clear')
  expect(byId.temp.label).toBe('Tokyo')
  expect(byId.temp.defaultEnabled).toBe(true)
  expect(byId.hilo.value).toBe('22°/14°')
  expect(byId.pop.value).toBe('60%')
  expect(byId.pop.percent).toBe(60)
  expect(byId.wind.value).toBe('4m/s')
})

test('lat/lon の別名と文字列値も受ける', async () => {
  const calls = stubFetch(OK_BODY)
  const g = await weatherProvider({ options: { lat: '35.68', lng: '139.69' } })
  expect(g?.id).toBe('weather')
  expect(calls[0]).toContain('latitude=35.68')
  expect(calls[0]).toContain('longitude=139.69')
})

test('units=imperial で fahrenheit/mph を要求し風表記を変える', async () => {
  const calls = stubFetch({
    current: { temperature_2m: 70, weather_code: 61, wind_speed_10m: 9 },
    daily: {},
  })
  const g = await weatherProvider({
    options: { latitude: 40.7, longitude: -74, units: 'imperial' },
  })
  expect(calls[0]).toContain('temperature_unit=fahrenheit')
  expect(calls[0]).toContain('wind_speed_unit=mph')
  const temp = g?.segments.find((s) => s.id === 'temp')
  expect(temp?.value).toBe('70° Rain')
  const wind = g?.segments.find((s) => s.id === 'wind')
  expect(wind?.value).toBe('9mph')
})

test('HTTP エラーは error state の group', async () => {
  stubFetch({}, { ok: false })
  const g = await weatherProvider({ options: { latitude: 1, longitude: 2 } })
  expect(g?.state).toBe('error')
  expect(g?.segments[0].value).toBe('n/a')
})

test('fetch 例外も error state の group', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('network'))) as unknown as typeof fetch
  const g = await weatherProvider({ options: { latitude: 1, longitude: 2 } })
  expect(g?.state).toBe('error')
})

test('current 欠落は error state', async () => {
  stubFetch({ daily: {} })
  const g = await weatherProvider({ options: { latitude: 1, longitude: 2 } })
  expect(g?.state).toBe('error')
})
