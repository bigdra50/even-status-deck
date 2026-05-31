// geo.ts の純粋な地理計算。実行: bun test src/geo.test.ts
import { expect, test } from 'bun:test'
import {
  bearingArrow,
  bearingDeg,
  compass8,
  compass16,
  formatBearing,
  formatDistance,
  haversineKm,
} from './geo'

test('haversineKm: 既知 2 点の距離(東京駅→新宿駅 ≒ 6.6km)', () => {
  const d = haversineKm(35.681, 139.767, 35.69, 139.7) // Tokyo → Shinjuku
  expect(d).toBeGreaterThan(5)
  expect(d).toBeLessThan(8)
  expect(haversineKm(0, 0, 0, 0)).toBe(0)
})

test('haversineKm: 緯度1度 ≒ 111km', () => {
  expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.2, 0)
})

test('bearingDeg: 真北/真東/真南/真西', () => {
  expect(bearingDeg(0, 0, 1, 0)).toBeCloseTo(0, 1) // 北
  expect(bearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 1) // 東
  expect(bearingDeg(1, 0, 0, 0)).toBeCloseTo(180, 1) // 南
  expect(bearingDeg(0, 1, 0, 0)).toBeCloseTo(270, 1) // 西
})

test('compass8 / compass16 / bearingArrow', () => {
  expect(compass8(0)).toBe('N')
  expect(compass8(45)).toBe('NE')
  expect(compass8(359)).toBe('N')
  expect(compass8(-45)).toBe('NW') // 負値も正規化
  expect(compass16(22.5)).toBe('NNE')
  expect(compass16(0)).toBe('N')
  expect(bearingArrow(0)).toBe('↑')
  expect(bearingArrow(90)).toBe('→')
  expect(bearingArrow(225)).toBe('↙')
})

test('formatBearing: style で切替', () => {
  expect(formatBearing(45, 'text')).toBe('NE')
  expect(formatBearing(45, 'compass16')).toBe('NE')
  expect(formatBearing(45, 'arrow')).toBe('↗')
})

test('formatDistance: km は m/小数/整数で桁を抑える', () => {
  expect(formatDistance(0.85, 'km')).toBe('850m')
  expect(formatDistance(2.34, 'km')).toBe('2.3km')
  expect(formatDistance(23.4, 'km')).toBe('23km')
})

test('formatDistance: mi 変換', () => {
  expect(formatDistance(1.60934, 'mi')).toBe('1.0mi') // 1.609km = 1.0mi(<10 → 小数)
  expect(formatDistance(50, 'mi')).toBe('31mi') // 31.07mi(>=10 → 整数)
  expect(formatDistance(0.05, 'mi')).toMatch(/ft$/) // 近距離は ft
})
