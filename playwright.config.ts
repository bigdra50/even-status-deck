import { defineConfig, devices } from '@playwright/test'

// companion (スマホ WebView 設定 UI) の E2E 回帰テスト。
// vite dev server を webServer で自動起動し、/api/status は各テストが page.route で
// 固定モックに差し替える (dev server のモックは実マシン依存で不安定なため)。
const PORT = 5273
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      // companion はスマホ縦画面 UI (#app max-width 480)。実機に近い縦長 viewport + touch。
      name: 'chromium-phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
