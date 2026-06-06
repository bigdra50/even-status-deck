// data-action の契約テスト。companion の UI は data-action 属性で click/change を
// CLICK_ACTIONS / CHANGE_ACTIONS / onFsClick(FS_ACTIONS) に委譲するため、
// 「放出される action 名」と「ハンドラテーブルのキー」のずれ (タイポ・登録漏れ・dead handler) を
// ソース走査で静的に検出する。放出側は全て静的文字列リテラル前提 (動的組み立てはこのテストを壊すので禁止)。
// 実行: bun test src/companion/actions.test.ts

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLICK_ACTIONS } from './actions'
import { CHANGE_ACTIONS } from './conditions-ui'
import { FS_ACTIONS } from './fs-editor'

// (?<!\[) で querySelector の `[data-action="..."]` セレクタを除外し、HTML 放出だけ拾う。
// [^"$] で `${...}` を含む動的組み立てをマッチ対象外にする (混入したら未処理扱いで検出される)。
function emittedActions(): Set<string> {
  const dir = import.meta.dir
  const out = new Set<string>()
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
    const src = readFileSync(join(dir, f), 'utf8')
    for (const m of src.matchAll(/(?<!\[)data-action="([^"$]+)"/g)) out.add(m[1])
  }
  return out
}

const emitted = emittedActions()
const handled = new Set<string>([
  ...Object.keys(CLICK_ACTIONS),
  ...Object.keys(CHANGE_ACTIONS),
  ...FS_ACTIONS,
])

test('放出される全 data-action にハンドラがある (登録漏れ・タイポ検出)', () => {
  const unhandled = [...emitted].filter((a) => !handled.has(a)).sort()
  expect(unhandled).toEqual([])
})

test('CLICK_ACTIONS の全キーが UI から放出される (dead handler 検出)', () => {
  const dead = Object.keys(CLICK_ACTIONS)
    .filter((a) => !emitted.has(a))
    .sort()
  expect(dead).toEqual([])
})

test('CHANGE_ACTIONS の全キーが UI から放出される (dead handler 検出)', () => {
  const dead = Object.keys(CHANGE_ACTIONS)
    .filter((a) => !emitted.has(a))
    .sort()
  expect(dead).toEqual([])
})

test('FS_ACTIONS の全キーが UI から放出される (dead handler 検出)', () => {
  const dead = FS_ACTIONS.filter((a) => !emitted.has(a)).sort()
  expect(dead).toEqual([])
})

test('opt-set は click(toggle) と change(select/number) の二経路に居る', () => {
  // 片方から消えたら「経路統合」という挙動変更なので、意図的な変更であることをここで強制確認させる。
  expect('opt-set' in CLICK_ACTIONS).toBe(true)
  expect('opt-set' in CHANGE_ACTIONS).toBe(true)
})
