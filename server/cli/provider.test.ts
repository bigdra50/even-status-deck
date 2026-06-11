// provider CLI の簡易フラグ parser (parseArgs) のテスト。
// flags / positional / passthrough (`--` 以降) / --timeout・--ttl の値検証を確認する。
// 実行: bun test server/cli/provider.test.ts
import { expect, test } from 'bun:test'
import { parseArgs } from './provider.ts'

test('positional のみ', () => {
  expect(parseArgs(['my-id', 'my-command'])).toEqual({
    positional: ['my-id', 'my-command'],
    passthrough: [],
    force: false,
    keepFile: false,
    all: false,
  })
})

test('--force / --keep-file / --all を認識する', () => {
  const r = parseArgs(['--force', '--keep-file', '--all', 'id'])
  expect(r.force).toBe(true)
  expect(r.keepFile).toBe(true)
  expect(r.all).toBe(true)
  expect(r.positional).toEqual(['id'])
})

test('--timeout / --ttl は正の整数を読む', () => {
  const r = parseArgs(['id', '--timeout', '1500', '--ttl', '60000'])
  expect(r.timeoutMs).toBe(1500)
  expect(r.ttlMs).toBe(60000)
  expect(r.positional).toEqual(['id'])
})

test('--timeout に不正な値が来たら無視して既定値のまま (警告)', () => {
  const r = parseArgs(['id', '--timeout', 'abc'])
  expect(r.timeoutMs).toBeUndefined()
  expect(r.positional).toEqual(['id'])
})

test('--timeout に 0 / 負数は不正として無視する', () => {
  expect(parseArgs(['--timeout', '0']).timeoutMs).toBeUndefined()
  expect(parseArgs(['--timeout', '-5']).timeoutMs).toBeUndefined()
})

test('未知のフラグは無視して positional は維持する', () => {
  const r = parseArgs(['--unknown', 'id'])
  expect(r.positional).toEqual(['id'])
})

test('-- 以降は passthrough になり、それ以前は flags/positional として処理する', () => {
  const r = parseArgs(['my-id', 'my-command', '--', '--verbose', '-x', 'arg'])
  expect(r.positional).toEqual(['my-id', 'my-command'])
  expect(r.passthrough).toEqual(['--verbose', '-x', 'arg'])
})

test('-- の後に --force 等があっても passthrough として渡る (フラグ扱いしない)', () => {
  const r = parseArgs(['id', 'cmd', '--', '--force'])
  expect(r.force).toBe(false)
  expect(r.passthrough).toEqual(['--force'])
})

test('--timeout が末尾で値が無い場合は無視する', () => {
  const r = parseArgs(['id', '--timeout'])
  expect(r.timeoutMs).toBeUndefined()
  expect(r.positional).toEqual(['id'])
})
