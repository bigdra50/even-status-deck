// mac-notifications の転送フィルタ shouldForward の振る舞い
// (deny 優先 / allow 絞り込み / 既定全通過 / 完全一致・部分一致)。
// 実行: bun test server/watchers/mac-notifications.test.ts
import { expect, test } from 'bun:test'
import { shouldForward } from './mac-notifications.ts'

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
