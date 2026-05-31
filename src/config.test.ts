// config 移行の回帰テスト。client source(weather/geoinfo 等)は opt-in なので、旧 config の升級で
// 既定 ON にしてはいけない(さもないと位置許可ダイアログ/外部 fetch が升級だけで走る)。
// 実行: bun test src/config.test.ts
import { expect, test } from 'bun:test'
import {
  activeProfile,
  addPlace,
  emptyConfig,
  GEOINFO_SOURCE_ID,
  migrate,
  removePlace,
  renamePlace,
  updatePlaceLocation,
  WEATHER_SOURCE_ID,
} from './config'

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

test('places CRUD: 追加/改名/座標更新/削除', () => {
  const cfg = emptyConfig()
  expect(cfg.places).toEqual([]) // ensureClientPlaces で初期化
  const home = addPlace(cfg, 'Home', 35.68, 139.69)
  addPlace(cfg, 'Work', 35.69, 139.7)
  expect(cfg.places).toHaveLength(2)
  expect(home.id).toMatch(/^pl_/)
  expect(renamePlace(cfg, home.id, 'My House')).toBe(true)
  expect(cfg.places?.find((p) => p.id === home.id)?.label).toBe('My House')
  expect(updatePlaceLocation(cfg, home.id, 36, 140)).toBe(true)
  expect(cfg.places?.find((p) => p.id === home.id)?.lat).toBe(36)
  expect(renamePlace(cfg, 'nope', 'X')).toBe(false)
  expect(removePlace(cfg, home.id)).toBe(true)
  expect(cfg.places).toHaveLength(1)
  expect(removePlace(cfg, home.id)).toBe(false) // 既に無い
})

test('migrate(v4 same): 不正な places を sanitize する', () => {
  // places は v4 の additive フィールド。v4 同版移行(migrateV4Same)で sanitize される。
  const v4 = emptyConfig()
  ;(v4 as unknown as { places: unknown[] }).places = [
    { id: 'ok', label: 'Good', lat: 35, lon: 139 },
    { id: 'bad1', label: 'NoCoord' }, // lat/lon 欠落 → 落とす
    { id: 'bad2', label: 'OutOfRange', lat: 999, lon: 0 }, // 範囲外 → 落とす
    { label: 'NoId', lat: 0, lon: 0 }, // id 欠落 → 落とす
  ]
  const cfg = migrate(v4 as unknown as Record<string, unknown>)
  expect(cfg.places?.map((p) => p.id)).toEqual(['ok'])
})
