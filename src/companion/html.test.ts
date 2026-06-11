// html.ts: data-action 付き要素 helper の escape / 属性組み立て契約。
// 実行: bun test src/companion/html.test.ts
import { expect, test } from 'bun:test'
import { actionButton, actionSelect, attrsHtml, optionsHtml } from './html'

// ── attrsHtml: 値の esc / undefined・boolean の扱い ──

test('attrsHtml: 値は esc される (引用符・山括弧)', () => {
  expect(attrsHtml({ title: '<a> & "b"' })).toBe(' title="&lt;a&gt; &amp; &quot;b&quot;"')
})

test('attrsHtml: undefined / false の属性は出さない', () => {
  expect(attrsHtml({ title: undefined, disabled: false })).toBe('')
})

test('attrsHtml: true は値無し属性 (disabled) として出す', () => {
  expect(attrsHtml({ disabled: true })).toBe(' disabled')
})

// ── actionButton: data-action 放出と属性順 ──

test('actionButton: data-action と class を放出する', () => {
  expect(actionButton('profile-add', 'Add', { cls: 'btn' })).toBe(
    '<button class="btn" data-action="profile-add">Add</button>',
  )
})

test('actionButton: attrs の値は esc される (注入防止)', () => {
  const html = actionButton('source-remove', 'x', { attrs: { 'data-id': '"><script>' } })
  expect(html).toContain('data-id="&quot;&gt;&lt;script&gt;"')
  expect(html).not.toContain('"><script>')
})

test('actionButton: extra は esc 適用済み前提でそのまま挟む (二重 escape しない)', () => {
  const html = actionButton('seg-toggle', 'x', { extra: 'data-key="a&amp;b"' })
  expect(html).toContain(' data-key="a&amp;b"')
  expect(html).not.toContain('&amp;amp;')
})

test('actionButton: disabled=true で値無し属性が付く', () => {
  expect(actionButton('cell-move', 'x', { disabled: true })).toContain(' disabled>')
})

// ── optionsHtml / actionSelect ──

test('optionsHtml: value/label を esc し selected を反映する', () => {
  const html = optionsHtml([
    { value: 'a&b', label: '<L>', selected: true },
    { value: 'c', label: 'C' },
  ])
  expect(html).toBe(
    '<option value="a&amp;b" selected>&lt;L&gt;</option><option value="c">C</option>',
  )
})

test('actionSelect: data-action 付き select に option 列を入れる', () => {
  const html = actionSelect('profile-switch', [{ value: 'p1', label: 'Work' }], { cls: 'sel' })
  expect(html).toBe(
    '<select class="sel" data-action="profile-switch"><option value="p1">Work</option></select>',
  )
})
