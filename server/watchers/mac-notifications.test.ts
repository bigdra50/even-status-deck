// mac-notifications の転送フィルタ shouldForward の振る舞い
// (deny 優先 / allow 絞り込み / 既定全通過 / 完全一致・部分一致)、
// および SQLite 行 / plist の row-parsing 純粋関数の fixture テスト。
// 実行: bun test server/watchers/mac-notifications.test.ts
import { expect, test } from 'bun:test'
import {
  extractFromJson,
  extractFromXml,
  parseRecordLine,
  parseSqliteRows,
  pickStr,
  shouldForward,
} from './mac-notifications.ts'

test('既定 (allow/deny 空) は全通過', () => {
  expect(shouldForward('com.apple.iCal', 'Meeting', undefined)).toBe(true)
  expect(shouldForward('com.apple.iCal', 'Meeting', {})).toBe(true)
  expect(shouldForward('com.apple.iCal', 'Meeting', { allow: [], deny: [] })).toBe(true)
})

test('deny にマッチすると転送しない', () => {
  expect(shouldForward('com.apple.AddressBook', 'X', { deny: ['com.apple.AddressBook'] })).toBe(
    false,
  )
})

test('deny は allow より優先する', () => {
  const rule = { allow: ['com.apple.AddressBook'], deny: ['com.apple.AddressBook'] }
  expect(shouldForward('com.apple.AddressBook', 'X', rule)).toBe(false)
})

test('allow が非空でマッチしないと転送しない', () => {
  const rule = { allow: ['com.apple.iCal'] }
  expect(shouldForward('com.apple.Mail', 'New mail', rule)).toBe(false)
})

test('allow が非空でマッチすれば転送する', () => {
  const rule = { allow: ['com.apple.iCal'] }
  expect(shouldForward('com.apple.iCal', 'Meeting', rule)).toBe(true)
})

test('identifier の部分一致 (大小無視) で照合する', () => {
  expect(shouldForward('com.apple.AddressBook', 'X', { deny: ['addressbook'] })).toBe(false)
  expect(shouldForward('com.tinyspeck.slackmacgap', 'msg', { allow: ['SLACK'] })).toBe(true)
})

test('title の部分一致 (大小無視) で照合する', () => {
  expect(shouldForward('com.apple.Mail', 'Slackbot reminder', { deny: ['slackbot'] })).toBe(false)
  expect(shouldForward('com.apple.Mail', 'Daily Standup', { allow: ['standup'] })).toBe(true)
})

test('完全一致は identifier に対して成立する', () => {
  // エントリ=identifier 完全一致 → deny
  expect(shouldForward('com.apple.iCal', 'unrelated title', { deny: ['com.apple.iCal'] })).toBe(
    false,
  )
})

// --- parseRecordLine / parseSqliteRows --------------------------------------------------

test('parseRecordLine: rec_id\\x01identifier\\x01hex を Row にする', () => {
  expect(parseRecordLine('123\x01com.apple.iCal\x01deadbeef')).toEqual({
    recId: 123,
    identifier: 'com.apple.iCal',
    hex: 'deadbeef',
  })
})

test('parseRecordLine: identifier が空でも hex があれば Row にする', () => {
  expect(parseRecordLine('5\x01\x01deadbeef')).toEqual({
    recId: 5,
    identifier: '',
    hex: 'deadbeef',
  })
})

test('parseRecordLine: 空行は null', () => {
  expect(parseRecordLine('')).toBeNull()
})

test('parseRecordLine: rec_id が数値でない行は null', () => {
  expect(parseRecordLine('not-a-number\x01com.apple.iCal\x01deadbeef')).toBeNull()
})

test('parseRecordLine: hex が空の行は null', () => {
  expect(parseRecordLine('123\x01com.apple.iCal\x01')).toBeNull()
})

test('parseSqliteRows: 複数行をパースし、壊れた行はスキップする', () => {
  const stdout = [
    '1\x01com.apple.iCal\x01aa',
    '', // 空行 → skip
    'broken\x01x\x01bb', // rec_id 不正 → skip
    '3\x01com.tinyspeck.slackmacgap\x01cc',
    '4\x01com.apple.Mail\x01', // hex 無し → skip
  ].join('\n')
  expect(parseSqliteRows(stdout)).toEqual([
    { recId: 1, identifier: 'com.apple.iCal', hex: 'aa' },
    { recId: 3, identifier: 'com.tinyspeck.slackmacgap', hex: 'cc' },
  ])
})

test('parseSqliteRows: 空文字列は空配列', () => {
  expect(parseSqliteRows('')).toEqual([])
})

// --- pickStr / extractFromJson / extractFromXml -----------------------------------------

test('pickStr: 候補 key を順に探し最初に見つかった string を返す', () => {
  expect(pickStr({ titl: 'Title', title: 'Other' }, ['titl', 'title'])).toBe('Title')
  expect(pickStr({ title: 'Other' }, ['titl', 'title'])).toBe('Other')
})

test('pickStr: 見つからない / 非 object なら空文字', () => {
  expect(pickStr({ foo: 1 }, ['titl', 'title'])).toBe('')
  expect(pickStr(null, ['titl'])).toBe('')
  expect(pickStr('string', ['titl'])).toBe('')
})

test('extractFromJson: req 配下の titl/subt/body をマップする', () => {
  const j = { req: { titl: 'Slack', subt: '#general', body: 'hello' } }
  expect(extractFromJson(j)).toEqual({ title: 'Slack', sub: '#general', body: 'hello' })
})

test('extractFromJson: root 直下の title/subtitle/message にもフォールバックする', () => {
  const j = { title: 'iCal', subtitle: 'Reminder', message: 'Meeting starts soon' }
  expect(extractFromJson(j)).toEqual({
    title: 'iCal',
    sub: 'Reminder',
    body: 'Meeting starts soon',
  })
})

test('extractFromJson: informativeText も body として拾う', () => {
  const j = { req: { titl: 'X', informativeText: 'info body' } }
  expect(extractFromJson(j)).toEqual({ title: 'X', sub: '', body: 'info body' })
})

test('extractFromJson: 不正/空入力は空文字の Notif になる (例外を投げない)', () => {
  expect(extractFromJson(null)).toEqual({ title: '', sub: '', body: '' })
  expect(extractFromJson('not an object')).toEqual({ title: '', sub: '', body: '' })
  expect(extractFromJson({})).toEqual({ title: '', sub: '', body: '' })
})

test('extractFromXml: <key>titl</key><string>...</string> を抽出する', () => {
  const xml = '<dict><key>titl</key><string>Slackbot</string></dict>'
  expect(extractFromXml(xml, 'titl')).toBe('Slackbot')
})

test('extractFromXml: 見つからない key は空文字', () => {
  const xml = '<dict><key>titl</key><string>Slackbot</string></dict>'
  expect(extractFromXml(xml, 'subt')).toBe('')
})

test('extractFromXml: XML エンティティをデコードする', () => {
  const xml = '<key>body</key><string>A &amp; B &lt;tag&gt; &quot;q&quot; &apos;s&apos;</string>'
  expect(extractFromXml(xml, 'body')).toBe(`A & B <tag> "q" 's'`)
})
