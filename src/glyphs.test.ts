// sanitizeGlyphs の検証 (絵文字 tofu 対策の機構)。
// 実行: bun test src/glyphs.test.ts
import { expect, test } from 'bun:test'
import { sanitizeGlyphs } from './glyphs'

test('マップ済み絵文字は ASCII に置換', () => {
  expect(sanitizeGlyphs('✅')).toBe('OK')
  expect(sanitizeGlyphs('❌')).toBe('x')
  expect(sanitizeGlyphs('⚠')).toBe('!')
  expect(sanitizeGlyphs('deploy ✅ done')).toBe('deploy OK done')
})

test('未マップの絵文字は除去 (空文字)', () => {
  expect(sanitizeGlyphs('🎉')).toBe('') // Misc Symbols and Pictographs
  expect(sanitizeGlyphs('🚀')).toBe('') // Transport
  expect(sanitizeGlyphs('😀')).toBe('') // Emoticons
  expect(sanitizeGlyphs('a🎉b')).toBe('ab')
})

test('box-drawing / 矢印 / 省略記号 / CJK / latin は不変', () => {
  expect(sanitizeGlyphs('━─')).toBe('━─') // box-drawing
  expect(sanitizeGlyphs('↓↑→')).toBe('↓↑→') // 矢印
  expect(sanitizeGlyphs('…')).toBe('…') // 省略記号 U+2026
  expect(sanitizeGlyphs('日本語テスト')).toBe('日本語テスト') // CJK
  expect(sanitizeGlyphs('Hello, World! 0123')).toBe('Hello, World! 0123') // basic latin
  expect(sanitizeGlyphs('CPU ━━─ 80% …')).toBe('CPU ━━─ 80% …')
})

test('不可視結合子/修飾子を除去 (ZWJ・異体字セレクタ・肌色修飾子)', () => {
  expect(sanitizeGlyphs('a‍b')).toBe('ab') // ZWJ
  expect(sanitizeGlyphs('a️b')).toBe('ab') // U+FE0F emoji selector
  expect(sanitizeGlyphs('a︎b')).toBe('ab') // U+FE0E text selector
  expect(sanitizeGlyphs('a\u{1f3fb}b')).toBe('ab') // 肌色修飾子
  // U+FE0F 付き警告 (text presentation 形) もマップ置換まで通る。
  expect(sanitizeGlyphs('⚠️')).toBe('!')
})

test('emoji シーケンス残骸 (keycap / tag) を除去し基底文字は残す', () => {
  // キーキャップ 1️⃣ = 1 + FE0F + U+20E3。囲み記号だけ残さず数字 1 を残す。
  expect(sanitizeGlyphs('1️⃣')).toBe('1')
  expect(sanitizeGlyphs('1⃣')).toBe('1') // FE0F 無しでも囲みを落とす
  expect(sanitizeGlyphs('#️⃣')).toBe('#')
  // タグシーケンス (スコットランド旗 = 黒旗 + 地域タグ + 終端 E007F) は丸ごと消える。
  expect(sanitizeGlyphs('\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}')).toBe('')
})

test('サロゲートを割らない (ペアを 1 code point として扱う)', () => {
  // 🎉 (U+1F389) はサロゲートペア。前後の latin を壊さず除去できる。
  expect(sanitizeGlyphs('x🎉y')).toBe('xy')
  // マップ済み + サロゲート絵文字の混在。
  expect(sanitizeGlyphs('✅🚀✅')).toBe('OKOK')
})

test('冪等: 二重適用しても結果は変わらない', () => {
  const inputs = ['deploy ✅ done', 'a🎉b━─…', '⚠️ 警告']
  for (const s of inputs) {
    const once = sanitizeGlyphs(s)
    expect(sanitizeGlyphs(once)).toBe(once)
  }
})
