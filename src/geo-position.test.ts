// geo-position.ts: geolocation 取得 + round2(PII 抑制)。
// 実行: bun test src/geo-position.test.ts
import { afterEach, expect, test } from 'bun:test'
import { getRoundedPosition } from './geo-position'

afterEach(() => {
  delete (globalThis as Record<string, unknown>).navigator
})

function mockGeolocation(lat: number, lon: number): void {
  ;(globalThis as Record<string, unknown>).navigator = {
    geolocation: {
      getCurrentPosition: (
        success: (p: { coords: { latitude: number; longitude: number } }) => void,
      ) => {
        success({ coords: { latitude: lat, longitude: lon } })
      },
    },
  }
}

test('getRoundedPosition: 座標を小数 2 桁に丸める', async () => {
  mockGeolocation(35.6894875, 139.6917064)
  const pos = await getRoundedPosition()
  expect(pos).toEqual({ lat: 35.69, lon: 139.69 })
})

test('getRoundedPosition: navigator.geolocation が無ければ reject', async () => {
  expect(getRoundedPosition()).rejects.toThrow('geolocation unavailable')
})

test('getRoundedPosition: geolocation エラーは code/message 付きで reject', async () => {
  ;(globalThis as Record<string, unknown>).navigator = {
    geolocation: {
      getCurrentPosition: (
        _success: unknown,
        error: (e: { code: number; message: string }) => void,
      ) => {
        error({ code: 1, message: 'denied' })
      },
    },
  }
  expect(getRoundedPosition()).rejects.toThrow('geolocation error 1: denied')
})
