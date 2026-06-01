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

// 新 IA: Home の source カードをタップして Source Detail へ遷移する。group/segment の
// expand/トグル/並べ替えは Home の flat リストではなく Source Detail (#detail-groups) に集約された。
export async function openSourceDetail(page: Page, sourceId: string): Promise<void> {
  await page.locator(`[data-action="open-source-detail"][data-src="${sourceId}"]`).click()
  await page.locator(`#detail-groups .src[data-key^="${sourceId}|"]`).first().waitFor()
}

// 新 IA: swipe-to-delete。カードを左へスワイプして背面の🗑を露出し remove-from-preset を押す。
// 実機のタッチ操作を TouchEvent で再現する (リスナは root 委譲・touchmove は preventDefault する)。
export async function swipeRemoveFromPreset(page: Page, sourceId: string): Promise<void> {
  const sel = `.swipe-row[data-src="${sourceId}"] > .swipe-fg`
  await page.locator(sel).waitFor()
  await page.evaluate((s) => {
    const fg = document.querySelector(s) as HTMLElement
    const r = fg.getBoundingClientRect()
    const y = r.top + r.height / 2
    const x0 = Math.round(r.right - 16)
    const fire = (type: string, x: number, withTouches: boolean) => {
      const t = new Touch({ identifier: 1, target: fg, clientX: x, clientY: y })
      fg.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: withTouches ? [t] : [],
          targetTouches: withTouches ? [t] : [],
          changedTouches: [t],
        }),
      )
    }
    fire('touchstart', x0, true)
    fire('touchmove', x0 - 24, true) // 軸を x に確定 (>SWIPE_SLOP)
    fire('touchmove', x0 - 120, true) // 開く閾値を超える (-SWIPE_ACTION_W に clamp)
    fire('touchend', x0 - 120, false)
  }, sel)
  await page.locator(`[data-action="remove-from-preset"][data-src="${sourceId}"]`).click()
}

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
