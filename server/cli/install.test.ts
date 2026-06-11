// parseManifestStatic の characterization テスト。
// `export default { ... }` から id/name/description/author/version を静的に読む heuristic parser。
// 文字列・コメント・ネストされた括弧を正しく飛ばすこと、object 以外は reject (null) すること、
// id が無ければ reject することを確認する。
// 実行: bun test server/cli/install.test.ts
import { expect, test } from 'bun:test'
import { parseManifestStatic } from './install.ts'

test('export default { ... } の object literal から id/name/description/author/version を読む', () => {
  const src = `
export default {
  id: 'my-provider',
  name: "My Provider",
  description: 'A test provider',
  author: 'Alice',
  version: '1.2.3',
  group: async (ctx) => ({ id: 'my-provider', label: 'X', segments: [] }),
}
`
  expect(parseManifestStatic(src)).toEqual({
    id: 'my-provider',
    name: 'My Provider',
    description: 'A test provider',
    author: 'Alice',
    version: '1.2.3',
  })
})

test('id のみの最小 manifest', () => {
  const src = `export default { id: 'minimal' }`
  expect(parseManifestStatic(src)).toEqual({
    id: 'minimal',
    name: null,
    description: null,
    author: null,
    version: null,
  })
})

test('id が無ければ null (reject)', () => {
  const src = `export default { name: 'no id here' }`
  expect(parseManifestStatic(src)).toBeNull()
})

test('export default { ... } 形でなければ null', () => {
  expect(parseManifestStatic(`export default function () { return {} }`)).toBeNull()
  expect(parseManifestStatic(`export const x = { id: 'x' }`)).toBeNull()
  expect(parseManifestStatic(`module.exports = { id: 'x' }`)).toBeNull()
  expect(parseManifestStatic('')).toBeNull()
})

test('行コメント・ブロックコメント中の export default {... は無視される', () => {
  const src = `
// export default { id: 'fake-line-comment' }
/* export default { id: 'fake-block-comment' } */
export default {
  id: 'real',
}
`
  expect(parseManifestStatic(src)?.id).toBe('real')
})

test('文字列リテラル内の波括弧・export default に惑わされない', () => {
  const src = `
const note = "this looks like export default { id: 'fake' } but is just a string"
const tmpl = \`also a template { id: 'fake2' }\`
export default {
  id: 'real-id',
  description: 'has braces { } and "quotes" inside',
}
`
  expect(parseManifestStatic(src)).toMatchObject({
    id: 'real-id',
    description: 'has braces { } and "quotes" inside',
  })
})

test('group 関数 (return 内の id 等) は静的フィールドとして拾わない', () => {
  const src = `
export default {
  id: 'outer-id',
  group: async (ctx) => {
    return { id: 'inner-fake-id', label: 'X', segments: [] }
  },
}
`
  expect(parseManifestStatic(src)?.id).toBe('outer-id')
})

test('ネストした括弧・配列があってもトップレベルの } で終端を認識する', () => {
  const src = `
export default {
  id: 'nested',
  config: { retries: [1, 2, (3 + 4)], nested: { a: { b: 'c' } } },
  version: '2.0.0',
}
`
  expect(parseManifestStatic(src)).toMatchObject({ id: 'nested', version: '2.0.0' })
})

test('エスケープされた引用符を含む文字列値も読む (raw のまま、unescape はしない)', () => {
  const src = `export default { id: 'esc', name: 'It\\'s a test' }`
  // 値は raw キャプチャなので \' はそのまま残る (unescape は行わない仕様)。
  expect(parseManifestStatic(src)?.name).toBe("It\\'s a test")
})

test('export の後に空白がない (exportXxx) は export default として認識しない', () => {
  const src = `exportDefault = { id: 'not-real' }\nexport default { id: 'real' }`
  expect(parseManifestStatic(src)?.id).toBe('real')
})

test('閉じ括弧が無い (truncated) 入力でも例外を投げない', () => {
  expect(() => parseManifestStatic('export default { id: "trunc"')).not.toThrow()
  // depth が閉じきらないが id は depth=1 で見つかっているので拾える
  expect(parseManifestStatic('export default { id: "trunc"')?.id).toBe('trunc')
})

test('未終端の文字列リテラルでも例外を投げない', () => {
  expect(() => parseManifestStatic('export default { id: "unterminated')).not.toThrow()
})

test('未終端のブロックコメントでも例外を投げない', () => {
  expect(() => parseManifestStatic('/* unterminated\nexport default { id: "x" }')).not.toThrow()
  expect(parseManifestStatic('/* unterminated\nexport default { id: "x" }')).toBeNull()
})
