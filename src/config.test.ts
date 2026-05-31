// config 移行の回帰テスト。client source(weather/geoinfo 等)は opt-in なので、旧 config の升級で
// 既定 ON にしてはいけない(さもないと位置許可ダイアログ/外部 fetch が升級だけで走る)。
// 実行: bun test src/config.test.ts
import { expect, test } from 'bun:test'
import {
  activeProfile,
  addPlace,
  addProfile,
  DEFAULT_PLACE_RADIUS_M,
  emptyConfig,
  GEOINFO_SOURCE_ID,
  migrate,
  PLACES_GROUP_ID,
  PLACES_SOURCE_ID,
  removePlace,
  renamePlace,
  setPlaceRadius,
  setProfileGeofence,
  updatePlaceLocation,
  WEATHER_SOURCE_ID,
} from './config'

test('setProfileGeofence: bind/解除 + 不正 place は外す (#43)', () => {
  const cfg = emptyConfig()
  const home = addPlace(cfg, 'Home', 35, 139)
  const prof = addProfile(cfg, 'P')
  expect(setProfileGeofence(cfg, prof.id, home.id, 'auto')).toBe(true)
  expect(prof.geofence).toEqual({ placeId: home.id, mode: 'auto' })
  // 存在しない place は bind しない(=解除)
  expect(setProfileGeofence(cfg, prof.id, 'nope', 'suggest')).toBe(true)
  expect(prof.geofence).toBeUndefined()
  // placeId=null で解除
  setProfileGeofence(cfg, prof.id, home.id, 'suggest')
  expect(setProfileGeofence(cfg, prof.id, null, 'suggest')).toBe(true)
  expect(prof.geofence).toBeUndefined()
  expect(setProfileGeofence(cfg, 'badprofile', home.id, 'auto')).toBe(false)
})

test('removePlace: bind 済み preset の geofence も外す (#43)', () => {
  const cfg = emptyConfig()
  const home = addPlace(cfg, 'Home', 35, 139)
  const prof = addProfile(cfg, 'P')
  setProfileGeofence(cfg, prof.id, home.id, 'auto')
  removePlace(cfg, home.id)
  expect(prof.geofence).toBeUndefined()
})

test('migrate: 不正な profile.geofence を sanitize する (#43)', () => {
  const v4 = emptyConfig()
  const p = addProfile(v4, 'P')
  ;(p as unknown as { geofence: unknown }).geofence = { placeId: '', mode: 'auto' } // 空 placeId
  const cfg = migrate(v4 as unknown as Record<string, unknown>)
  expect(cfg.profiles.find((x) => x.id === p.id)?.geofence).toBeUndefined()
})

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

test('removePlace: 他 segment の visibility から inPlace leaf を掃除する (#43)', () => {
  const cfg = emptyConfig()
  const home = addPlace(cfg, 'Home', 35, 139)
  // 別 source の segment が「At Home」(+ threshold)条件を持つ状態を作る。
  cfg.groups['server.x'] = {
    g: {
      segments: [
        {
          id: 's1',
          visibility: {
            combinator: 'and',
            conditions: [
              { kind: 'inPlace', placeId: home.id },
              { kind: 'threshold', op: 'gte', value: 50 },
            ],
          },
        },
        {
          id: 's2',
          visibility: { combinator: 'and', conditions: [{ kind: 'inPlace', placeId: home.id }] },
        },
      ],
    },
  }
  expect(removePlace(cfg, home.id)).toBe(true)
  const segs = cfg.groups['server.x'].g.segments
  // s1: inPlace 除去、threshold は残る
  expect(segs[0].visibility?.conditions).toEqual([{ kind: 'threshold', op: 'gte', value: 50 }])
  // s2: 条件が空になったので visibility ごと外れる(= 常時表示へ)
  expect(segs[1].visibility).toBeUndefined()
})

test('removePlace: 素材/view/glassLayout の孤立 chip を掃除する', () => {
  const cfg = emptyConfig()
  const home = addPlace(cfg, 'Home', 35, 139)
  const prof = activeProfile(cfg)
  // sync が補充した想定で素材/view/glassLayout に place segment を手で配置する。
  cfg.groups[PLACES_SOURCE_ID] ??= {}
  cfg.groups[PLACES_SOURCE_ID][PLACES_GROUP_ID] = { segments: [{ id: home.id }] }
  prof.view.groups[PLACES_SOURCE_ID] = {
    [PLACES_GROUP_ID]: { enabled: true, segments: { [home.id]: true } },
  }
  const placeKey = `${PLACES_SOURCE_ID}|${PLACES_GROUP_ID}|${home.id}`
  prof.view.glassLayout = { rows: [[placeKey, 'builtin.local|clock|datetime']] }

  expect(removePlace(cfg, home.id)).toBe(true)
  expect(cfg.groups[PLACES_SOURCE_ID][PLACES_GROUP_ID].segments).toEqual([]) // 素材掃除
  expect(prof.view.groups[PLACES_SOURCE_ID][PLACES_GROUP_ID].segments[home.id]).toBeUndefined() // view 掃除
  expect(prof.view.glassLayout?.rows[0]).toEqual(['builtin.local|clock|datetime']) // place chip だけ除去
})

test('places radius: 既定 150m / clamp / migrate 補完 (#43)', () => {
  const cfg = emptyConfig()
  const p = addPlace(cfg, 'Home', 35, 139)
  expect(p.radiusM).toBe(DEFAULT_PLACE_RADIUS_M)
  expect(setPlaceRadius(cfg, p.id, 300)).toBe(true)
  expect(cfg.places?.[0].radiusM).toBe(300)
  expect(setPlaceRadius(cfg, p.id, 5)).toBe(true) // 下限 clamp(20)
  expect(cfg.places?.[0].radiusM).toBe(20)
  expect(setPlaceRadius(cfg, p.id, 999_999)).toBe(true) // 上限 clamp(50000)
  expect(cfg.places?.[0].radiusM).toBe(50_000)
  // migrate: radiusM 欠落は既定で補完
  const v4 = emptyConfig()
  ;(v4 as unknown as { places: unknown[] }).places = [{ id: 'x', label: 'X', lat: 0, lon: 0 }]
  const migrated = migrate(v4 as unknown as Record<string, unknown>)
  expect(migrated.places?.[0].radiusM).toBe(DEFAULT_PLACE_RADIUS_M)
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
