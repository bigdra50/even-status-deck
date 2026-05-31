// config 移行の回帰テスト。client source(weather/geoinfo 等)は opt-in なので、旧 config の升級で
// 既定 ON にしてはいけない(さもないと位置許可ダイアログ/外部 fetch が升級だけで走る)。
// 実行: bun test src/config.test.ts
import { expect, test } from 'bun:test'
import { activeProfile, GEOINFO_SOURCE_ID, migrate, WEATHER_SOURCE_ID } from './config'

test('migrate(v3): client source は enabledSourceIds に入れない(opt-in 維持)', () => {
  const v3 = {
    version: 3,
    sources: [{ id: 'server.a', kind: 'server', label: 'A', url: 'http://a.local/api/status' }],
    groups: {},
    groupOrder: [],
  }
  const cfg = migrate(v3 as unknown as Record<string, unknown>)
  // weather/geoinfo source は素材としては存在する(Add source で出せる)
  expect(cfg.sources.some((s) => s.id === WEATHER_SOURCE_ID)).toBe(true)
  expect(cfg.sources.some((s) => s.id === GEOINFO_SOURCE_ID)).toBe(true)
  // が、Default profile では有効化されない(server.a は有効、client は無効)
  const enabled = activeProfile(cfg).enabledSourceIds
  expect(enabled).toContain('server.a')
  expect(enabled).not.toContain(WEATHER_SOURCE_ID)
  expect(enabled).not.toContain(GEOINFO_SOURCE_ID)
})

test('migrate(legacy v1/v2): client source は enabledSourceIds に入れない', () => {
  const legacy = {
    machines: {
      box1: { id: 'server.box1', label: 'Box1', url: 'http://box1.local/api/status', sources: {} },
    },
  }
  const cfg = migrate(legacy as unknown as Record<string, unknown>)
  const enabled = activeProfile(cfg).enabledSourceIds
  expect(enabled).toContain('server.box1')
  expect(enabled).not.toContain(WEATHER_SOURCE_ID)
  expect(enabled).not.toContain(GEOINFO_SOURCE_ID)
})
