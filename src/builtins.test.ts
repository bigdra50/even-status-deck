// A 系データソース (日付経過バー・月相) の純計算関数を検証する。
// 実行: bun test src/builtins.test.ts
import { expect, test } from 'bun:test'
import {
  localStatus,
  monthProgress,
  moonAge,
  moonIllumination,
  spanProgress,
  weekProgress,
  yearProgress,
} from './builtins'

test('spanProgress: 範囲内は線形・範囲外はクランプ・空区間は 0', () => {
  expect(spanProgress(0, 0, 100)).toBe(0)
  expect(spanProgress(50, 0, 100)).toBe(50)
  expect(spanProgress(100, 0, 100)).toBe(100)
  expect(spanProgress(-5, 0, 100)).toBe(0) // 下方クランプ
  expect(spanProgress(150, 0, 100)).toBe(100) // 上方クランプ
  expect(spanProgress(5, 10, 10)).toBe(0) // end<=start
  expect(spanProgress(5, 10, 0)).toBe(0)
})

test('yearProgress: 1/1 0:00 は 0%、年末は ~100%、年央は ~50%', () => {
  expect(yearProgress(new Date(2026, 0, 1))).toBe(0)
  expect(yearProgress(new Date(2026, 11, 31, 23, 59))).toBeGreaterThan(99)
  // 2026 は平年 (365 日)。7/2 0:00 は 182 日経過 ≈ 49.86%。
  expect(yearProgress(new Date(2026, 6, 2))).toBeCloseTo((182 / 365) * 100, 5)
})

test('monthProgress: 1 日 0:00 は 0%、月央は ~50%', () => {
  expect(monthProgress(new Date(2026, 5, 1))).toBe(0) // 6 月 (30 日)
  expect(monthProgress(new Date(2026, 5, 16))).toBeCloseTo((15 / 30) * 100, 5)
  expect(monthProgress(new Date(2026, 1, 1))).toBe(0) // 2 月境界も 0
})

test('weekProgress: 月曜 0:00 は 0%、週内は経過日に比例 (月曜始まり)', () => {
  const mon = new Date(2026, 0, 5) // 2026-01-05
  expect(mon.getDay()).toBe(1) // Monday であることを確認 (週起点)
  expect(weekProgress(mon)).toBe(0)
  const wed = new Date(2026, 0, 7) // +2 日 (水 0:00)
  expect(weekProgress(wed)).toBeCloseTo((2 / 7) * 100, 5)
  const sun = new Date(2026, 0, 11, 12) // 日曜昼 = 6.5 日経過
  expect(weekProgress(sun)).toBeCloseTo((6.5 / 7) * 100, 5)
})

test('moonAge: 基準新月で 0、半周期で ~半月、常に [0, 朔望月) に収まる', () => {
  const newMoon = new Date(Date.UTC(2000, 0, 6, 18, 14))
  expect(moonAge(newMoon)).toBeCloseTo(0, 6)
  const synodic = 29.530588853
  const half = new Date(newMoon.getTime() + (synodic / 2) * 86_400_000)
  expect(moonAge(half)).toBeCloseTo(synodic / 2, 4)
  // 基準より前の日付でも負にならない (剰余の正規化)。
  const before = new Date(Date.UTC(1999, 0, 1))
  const age = moonAge(before)
  expect(age).toBeGreaterThanOrEqual(0)
  expect(age).toBeLessThan(synodic)
})

test('moonIllumination: 新月=0%・満月=100%・両端でクランプ範囲内', () => {
  const synodic = 29.530588853
  expect(moonIllumination(0)).toBeCloseTo(0, 6)
  expect(moonIllumination(synodic / 2)).toBeCloseTo(100, 6)
  const quarter = moonIllumination(synodic / 4)
  expect(quarter).toBeGreaterThan(40)
  expect(quarter).toBeLessThan(60)
})

test('localStatus: clock/calendar/moon group を含み、calendar は year/month/week を持つ', () => {
  const doc = localStatus()
  const ids = doc.groups.map((g) => g.id)
  expect(ids).toContain('clock')
  expect(ids).toContain('calendar')
  expect(ids).toContain('moon')
  const cal = doc.groups.find((g) => g.id === 'calendar')
  expect(cal?.segments.map((s) => s.id)).toEqual(['year', 'month', 'week'])
  for (const s of cal?.segments ?? []) {
    expect(typeof s.percent).toBe('number') // bar 用 percent を持つ
    expect(s.value).toMatch(/^\d+%$/)
  }
  const moon = doc.groups.find((g) => g.id === 'moon')
  expect(moon?.segments[0]?.value).toMatch(/^\d+\.\d+d$/) // "4.2d"
})
