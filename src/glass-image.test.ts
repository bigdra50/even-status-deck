// image cell の純粋部 (sparkline 形状・icon 語彙) のテスト。canvas 描画はブラウザ専用なので対象外。
// 実行: bun test src/glass-image.test.ts
import { expect, test } from 'bun:test'
import { glassIconSvg, sparklinePoints } from './glass-image'

test('sparklinePoints: 値域を [pad, h-pad] に正規化し x は等間隔', () => {
  const pts = sparklinePoints(
    [
      { t: 0, v: 0 },
      { t: 1, v: 50 },
      { t: 2, v: 100 },
    ],
    100,
    50,
    5,
  )
  expect(pts).toHaveLength(3)
  expect(pts[0]).toEqual([5, 45]) // 最小値 → 下端
  expect(pts[2]).toEqual([95, 5]) // 最大値 → 上端
  expect(pts[1]?.[0]).toBe(50)
  expect(pts[1]?.[1]).toBe(25)
})

test('sparklinePoints: 0 件は空 / 1 件・平坦は中央の水平線', () => {
  expect(sparklinePoints([], 100, 50)).toEqual([])
  const one = sparklinePoints([{ t: 0, v: 42 }], 100, 50, 5)
  expect(one).toEqual([
    [5, 25],
    [95, 25],
  ])
  const flat = sparklinePoints(
    [
      { t: 0, v: 7 },
      { t: 1, v: 7 },
    ],
    100,
    50,
  )
  expect(flat.every(([, y]) => y === 25)).toBe(true)
})

test('glassIconSvg: 語彙内は SVG、語彙外は null', () => {
  expect(glassIconSvg('battery')).toContain('<svg')
  expect(glassIconSvg('nope')).toBeNull()
})
