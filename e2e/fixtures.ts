import type { Page } from '@playwright/test'
import type { StatusDoc } from '../src/status-types'

// /api/status のモック。dev server の実装は claude/codex CLI や OAuth keychain に依存して
// 不安定なため、テストでは固定値を page.route で返して決定的にする。
// 既定サーバ ID は config.ts の LOCAL_SOURCE_ID = 'server.local'。
export const SERVER_ID = 'server.local'

export const STATUS: StatusDoc = {
  version: 1,
  ts: 1_700_000_000_000,
  groups: [
    {
      id: 'cpu',
      label: 'CPU',
      segments: [
        { id: 'usage', label: '', value: '46%', percent: 46, defaultEnabled: true },
        { id: 'load', label: 'Load', value: '1.2', defaultEnabled: true },
      ],
    },
    {
      id: 'mem',
      label: 'Memory',
      segments: [{ id: 'used', label: '', value: '8.1G', percent: 62, defaultEnabled: true }],
    },
  ],
}

export const MACHINE = { machineId: 'testbox', label: 'TestBox', availableSources: ['cpu', 'mem'] }

// segKey ヘルパ (sourceId|groupId)。
export const key = (groupId: string) => `${SERVER_ID}|${groupId}`

// アプリ由来のコンソールエラー/例外を収集する (favicon 等のノイズは除外)。
// goto より前に呼ぶこと (ロード時のエラーも拾うため)。
export function attachConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}
