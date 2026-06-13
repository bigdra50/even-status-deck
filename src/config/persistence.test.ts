import { beforeEach, expect, test } from 'bun:test'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { emptyConfig } from './defaults'
import {
  __resetConfigPersistenceForTest,
  loadConfig,
  saveConfig,
  setConfigBridge,
} from './persistence'
import { addProfile } from './profiles'
import { addServer } from './sources'

// getLocalStorage の挙動を差し替えられるモック bridge。store は実機 localStorage の代役。
function mockBridge(opts: {
  store: { value: string | null }
  failGetUntil?: number // この回数までの getLocalStorage を throw させる (transient 障害の再現)
  failSet?: boolean // setLocalStorage を常に throw させる (容量超過/書込み失敗の再現)
}): { bridge: EvenAppBridge; getCalls: () => number; setCalls: () => number } {
  let getCalls = 0
  let setCalls = 0
  const bridge = {
    async getLocalStorage(_k: string): Promise<string | null> {
      getCalls++
      if (opts.failGetUntil && getCalls <= opts.failGetUntil) throw new Error('storage not ready')
      return opts.store.value
    },
    async setLocalStorage(_k: string, v: string): Promise<void> {
      setCalls++
      if (opts.failSet) throw new Error('quota exceeded')
      opts.store.value = v
    },
  } as unknown as EvenAppBridge
  return { bridge, getCalls: () => getCalls, setCalls: () => setCalls }
}

beforeEach(() => {
  __resetConfigPersistenceForTest()
})

test('saves persist to bridge after a successful load', async () => {
  const store = { value: null as string | null }
  const { bridge, setCalls } = mockBridge({ store })
  setConfigBridge(bridge)

  await loadConfig() // 確実に空 → bridgeState ready (書き込み解禁)
  const cfg = emptyConfig()
  addServer(cfg, 'My Mac')
  addProfile(cfg, 'Work')
  await saveConfig(cfg)

  expect(setCalls()).toBe(1)
  expect(store.value).not.toBeNull()
  const reloaded = await loadConfig()
  expect(reloaded.profiles.some((p) => p.name === 'Work')).toBe(true)
})

test('transient getLocalStorage failure does NOT clobber stored config', async () => {
  // 既に本物の config が保存済み (preset を含む)。
  const seed = emptyConfig()
  addServer(seed, 'My Mac')
  addProfile(seed, 'Work')
  const store = { value: JSON.stringify(seed) }

  // アップデート直後の初回起動: getLocalStorage が 2 回とも throw (retry も失敗)。
  const { bridge, setCalls } = mockBridge({ store, failGetUntil: 2 })
  setConfigBridge(bridge)

  const loaded = await loadConfig() // 読み取り失敗 → emptyConfig フォールバック
  expect(loaded.profiles.some((p) => p.name === 'Work')).toBe(false) // 空が返る

  // ここでユーザーが何か触って save が走っても、bridge を空で上書きしてはならない。
  await saveConfig(loaded)
  expect(setCalls()).toBe(0) // bridge への書き込みは抑止
  expect(store.value).toBe(JSON.stringify(seed)) // 永続側は無傷

  // ストレージが回復した後の load は本物を返し、以後の save は通る。
  const recovered = await loadConfig()
  expect(recovered.profiles.some((p) => p.name === 'Work')).toBe(true)
  recovered.profiles.push({
    id: 'p2',
    name: 'Home',
    enabledSourceIds: [],
    view: { groups: {}, groupOrder: [] },
  })
  await saveConfig(recovered)
  expect(setCalls()).toBe(1)
  const reloaded = await loadConfig()
  expect(reloaded.profiles.some((p) => p.name === 'Home')).toBe(true)
})

test('transient failure then retry success establishes the store on first load', async () => {
  const seed = emptyConfig()
  addServer(seed, 'My Mac')
  const store = { value: JSON.stringify(seed) }
  // 1 回目の getLocalStorage は throw、retry (2 回目) は成功。
  const { bridge } = mockBridge({ store, failGetUntil: 1 })
  setConfigBridge(bridge)

  const loaded = await loadConfig()
  expect(loaded.sources.some((s) => s.label === 'My Mac')).toBe(true) // retry で本物を読めた
})

test('setLocalStorage failure is surfaced and kept in memory (not silently lost)', async () => {
  const store = { value: null as string | null }
  const warnings: unknown[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    const { bridge, setCalls } = mockBridge({ store, failSet: true })
    setConfigBridge(bridge)
    await loadConfig() // ready

    const cfg = emptyConfig()
    addProfile(cfg, 'Work')
    await saveConfig(cfg)

    expect(setCalls()).toBe(1) // 書き込みは試みた
    expect(store.value).toBeNull() // が失敗 (永続化されず)
    expect(warnings.some((w) => String(w).includes('setLocalStorage failed'))).toBe(true) // ログに出た

    // memory には残るので、同一セッションの load はそれを返す。
    const loaded = await loadConfig()
    expect(loaded.profiles.some((p) => p.name === 'Work')).toBe(true)
  } finally {
    console.warn = origWarn
  }
})
