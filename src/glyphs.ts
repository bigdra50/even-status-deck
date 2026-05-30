// グラス表示の絵文字 tofu(□)対策。LVGL のフォントに絵文字グリフが無く □ で出るため、
// グラスへ渡る最終文字列を sanitizeGlyphs に通し、絵文字を小さな ASCII マップで置換 or 除去する。
// box-drawing / 矢印 / 省略記号 / CJK / basic latin は不変 (status 描画で常用するため絶対に壊さない)。
//
// ※ tofu の実集合は実機 probe で確定する (フォント依存)。ここはブロック単位の機構のみ。
//   範囲/マップの精緻化は issue #11 に残す。

// 絵文字 code point → ASCII 置換。未掲載の絵文字は除去 (空文字)。小さく保つ。
const GLYPH_MAP = new Map<number, string>([
  [0x2705, 'OK'], // ✅ white heavy check mark
  [0x2714, 'OK'], // ✔ heavy check mark
  [0x274c, 'x'], // ❌ cross mark
  [0x274e, 'x'], // ❎ negative squared cross mark
  [0x2716, 'x'], // ✖ heavy multiplication x
  [0x26a0, '!'], // ⚠ warning sign
  [0x2757, '!'], // ❗ heavy exclamation mark
  [0x2753, '?'], // ❓ black question mark ornament
])

// 除去対象の不可視結合子/修飾子と emoji シーケンス残骸 (単一 code point)。
// 絵文字本体を除去しても結合記号だけがグラスへ残らないよう、ここで一緒に落とす。
function isInvisibleModifier(cp: number): boolean {
  if (cp === 0x200d) return true // ZWJ (zero width joiner)
  if (cp === 0xfe0e || cp === 0xfe0f) return true // 異体字セレクタ (text/emoji)
  if (cp === 0x20e3) return true // 結合囲みキーキャップ (例: 1️⃣ の囲み。基底の数字 1 は残す)
  if (cp === 0xe0001 || (cp >= 0xe0020 && cp <= 0xe007f)) return true // タグ文字 (旗の地域サブタグ等)
  return false
}

// 肌色修飾子 (Fitzpatrick) U+1F3FB–U+1F3FF。
function isSkinToneModifier(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff
}

// 置換 or 除去の対象とする絵文字ブロック (tofu になりうる範囲)。
function isEmojiBlock(cp: number): boolean {
  if (cp >= 0x1f600 && cp <= 0x1f64f) return true // Emoticons
  if (cp >= 0x1f300 && cp <= 0x1f5ff) return true // Misc Symbols and Pictographs
  if (cp >= 0x1f680 && cp <= 0x1f6ff) return true // Transport and Map Symbols
  if (cp >= 0x1f900 && cp <= 0x1faff) return true // Supplemental Symbols and Pictographs
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true // Regional Indicators
  if (cp >= 0x2600 && cp <= 0x26ff) return true // Misc Symbols
  if (cp >= 0x2700 && cp <= 0x27bf) return true // Dingbats
  return false
}

// グラスへ渡る最終文字列をサニタイズする。絵文字ブロックは ASCII マップ置換 or 除去、
// 不可視結合子/修飾子は除去。それ以外 (box-drawing / 矢印 / 省略記号 / CJK / latin) は完全保持。
// 冪等 (二重適用しても結果は変わらない)。
export function sanitizeGlyphs(s: string): string {
  let out = ''
  // for..of は code point 単位で走査する (サロゲートペアを割らない)。
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (isInvisibleModifier(cp) || isSkinToneModifier(cp)) continue
    if (isEmojiBlock(cp)) {
      out += GLYPH_MAP.get(cp) ?? '' // マップにあれば ASCII、無ければ除去
      continue
    }
    out += ch // 絵文字以外は完全保持
  }
  return out
}
