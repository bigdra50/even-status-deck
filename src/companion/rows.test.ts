// rows.ts の純 HTML 生成関数 (DOM-free) のテスト。ctx(./state) に最小 Config を入れて検証する。
// 実行: bun test src/companion/rows.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { activeView, addServer, BUILTIN_SOURCE_ID, emptyConfig } from '../config'
import { setGlassBattery } from '../device-state'
import { setSources } from '../store'
import { segKey } from '../visibility'
import {
  allPlaceableKeys,
  groupHeadingCollides,
  headingCollidesInSomeProfile,
  renderSourceGroups,
  segLabelParts,
  sourceAddRow,
  sourceManageRow,
  sourceNavRow,
  sourceSection,
} from './rows'
import { ctx } from './state'

beforeEach(() => {
  ctx.config = emptyConfig()
  setSources(ctx.config.sources)
})

afterEach(() => {
  setSources([])
  setGlassBattery(null, false)
})

test('sourceSection: builtin/server/client(app_bundled) を分類する', () => {
  const builtin = ctx.config.sources.find((s) => s.id === BUILTIN_SOURCE_ID)
  expect(builtin && sourceSection(builtin)).toBe('included')
  const server = addServer(ctx.config, 'My Mac', 'http://127.0.0.1:8723')
  expect(sourceSection(server)).toBe('connected')
})

test('sourceNavRow: builtin は swipe-row のみ (削除ボタン無し)', () => {
  const builtin = ctx.config.sources.find((s) => s.id === BUILTIN_SOURCE_ID)
  if (!builtin) throw new Error('builtin source not found')
  const html = sourceNavRow(builtin)
  expect(html).toContain('data-action="open-source-detail"')
  expect(html).toContain(`data-src="${BUILTIN_SOURCE_ID}"`)
  expect(html).not.toContain('remove-from-preset')
})

test('sourceNavRow: server source は swipe-to-delete (remove-from-preset) を持つ', () => {
  const server = addServer(ctx.config, 'My Mac', 'http://127.0.0.1:8723')
  const html = sourceNavRow(server)
  expect(html).toContain('data-action="remove-from-preset"')
  expect(html).toContain(`data-src="${server.id}"`)
  expect(html).toContain(esc(server.label))
})

test('sourceManageRow: edit-source ボタンと label/note を出す', () => {
  const server = addServer(ctx.config, 'My <Mac>', 'http://127.0.0.1:8723')
  const html = sourceManageRow(server)
  expect(html).toContain('data-action="edit-source"')
  expect(html).toContain(`data-src="${server.id}"`)
  expect(html).toContain('My &lt;Mac&gt;') // esc 済み
})

test('sourceAddRow: add-to-preset ボタンを出す', () => {
  const server = addServer(ctx.config, 'My Mac', 'http://127.0.0.1:8723')
  const html = sourceAddRow(server)
  expect(html).toContain('data-action="add-to-preset"')
  expect(html).toContain(`data-src="${server.id}"`)
})

test('segLabelParts: builtin は code-owned ラベル (BUILTIN_GROUP_LABELS/SEG_LABELS)', () => {
  const { group, seg } = segLabelParts(`${BUILTIN_SOURCE_ID}|clock|datetime`)
  expect(group).toBe('Clock')
  expect(seg).toBe('Date & Time')
})

test('allPlaceableKeys: builtin の clock/g2 segment が含まれる (既定 ON)', () => {
  const keys = allPlaceableKeys()
  expect(keys).toContain(segKey(BUILTIN_SOURCE_ID, 'clock', 'datetime'))
  expect(keys).toContain(segKey(BUILTIN_SOURCE_ID, 'g2', 'level'))
})

test('allPlaceableKeys: segment を OFF にすると除外される', () => {
  const view = activeView(ctx.config)
  const vg = view.groups[BUILTIN_SOURCE_ID]?.g2
  if (!vg) throw new Error('builtin g2 group view not found')
  vg.segments.level = false
  const keys = allPlaceableKeys()
  expect(keys).not.toContain(segKey(BUILTIN_SOURCE_ID, 'g2', 'level'))
  expect(keys).toContain(segKey(BUILTIN_SOURCE_ID, 'g2', 'rate'))
})

test('headingCollidesInSomeProfile: 同名 heading の別 group が同 profile の groupOrder に無ければ null', () => {
  // 'G2' は g2 group 自身の見出し (BUILTIN_GROUP_LABELS.g2) と衝突するので、
  // どの group の見出しとも一致しないラベルで判定する。
  expect(headingCollidesInSomeProfile(BUILTIN_SOURCE_ID, 'clock', 'Nonexistent Heading')).toBeNull()
})

test('headingCollidesInSomeProfile: 同 profile の groupOrder にあれば衝突 group id を返す', () => {
  // builtin の clock を 'G2' にリネームしようとすると、g2 group (見出し 'G2') と同 profile の
  // groupOrder に同居しているためマージ対象として 'g2' が返る。
  expect(headingCollidesInSomeProfile(BUILTIN_SOURCE_ID, 'clock', 'G2')).toBe('g2')
})

test('groupHeadingCollides: 衝突なしの builtin group は false', () => {
  expect(groupHeadingCollides(BUILTIN_SOURCE_ID, 'clock')).toBe(false)
  expect(groupHeadingCollides(BUILTIN_SOURCE_ID, 'g2')).toBe(false)
})

test('renderSourceGroups: builtin の group 行 (toggle-group / src-name) を描く', () => {
  // g2 (battery) group は localStatus() が getGlassBattery().level != null のときだけ含めるため、
  // テスト用にグラスバッテリー値を設定してから setSources で取り込む。
  setGlassBattery(82, false)
  setSources(ctx.config.sources)
  const html = renderSourceGroups(BUILTIN_SOURCE_ID)
  expect(html).toContain('data-action="toggle-group"')
  expect(html).toContain(`data-key="${BUILTIN_SOURCE_ID}|clock"`)
  expect(html).toContain(`data-key="${BUILTIN_SOURCE_ID}|g2"`)
})

test('renderSourceGroups: データの無い source は "No data" を出す', () => {
  const server = addServer(ctx.config, 'My Mac', 'http://127.0.0.1:8723')
  const html = renderSourceGroups(server.id)
  expect(html).toContain('No data from this source yet.')
})

// esc は escape.ts の実装と等価 (テスト内の期待値整形用。esc 自体は rows.ts が呼ぶ)。
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
