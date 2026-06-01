// config 移行の回帰テスト。client source(weather/geoinfo 等)は opt-in なので、旧 config の升級で
// 既定 ON にしてはいけない(さもないと位置許可ダイアログ/外部 fetch が升級だけで走る)。
// 実行: bun test src/config.test.ts
import { expect, test } from 'bun:test'
import {
  activeProfile,
  addPlace,
  addProfile,
  addServer,
  BUILTIN_SOURCE_ID,
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
  syncSourceWithStatus,
  updatePlaceLocation,
  WEATHER_SOURCE_ID,
} from './config'
import type { StatusDoc } from './status-types'

// 表示モデル Phase1 用の最小 StatusDoc ビルダ (g2 group の segment を渡す)。
function g2Doc(segIds: string[]): StatusDoc {
  return {
    version: 1,
    ts: 0,
    groups: [
      { id: 'g2', label: '', segments: segIds.map((id) => ({ id, label: '', value: 'x' })) },
    ],
  }
}

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

// ── 表示モデル Phase1: category seed / displayOwner / tags sanitize (tasks/display-model-spec.md) ──

test('syncSourceWithStatus: 新規 segment に category を seed する', () => {
  const cfg = emptyConfig()
  syncSourceWithStatus(cfg, BUILTIN_SOURCE_ID, g2Doc(['level', 'rate', 'eta']))
  const segs = cfg.groups[BUILTIN_SOURCE_ID].g2.segments
  expect(segs.find((s) => s.id === 'level')?.category).toBe('battery')
  expect(segs.find((s) => s.id === 'rate')?.category).toBe('power_rate')
  expect(segs.find((s) => s.id === 'eta')?.category).toBe('duration')
})

test('migrate: builtin source に displayOwner=Glass を seed する', () => {
  const cfg = migrate(emptyConfig() as unknown as Record<string, unknown>)
  expect(cfg.sources.find((s) => s.id === BUILTIN_SOURCE_ID)?.displayOwner).toBe('Glass')
})

test('migrate: 旧 config(category なし)を backfill する', () => {
  // sync で g2 を正規登録 → category を消して旧 config を再現 → migrate で再付与。
  const cfg = emptyConfig()
  syncSourceWithStatus(cfg, BUILTIN_SOURCE_ID, g2Doc(['level']))
  for (const sm of cfg.groups[BUILTIN_SOURCE_ID].g2.segments) {
    delete (sm as { category?: string }).category
  }
  const migrated = migrate(JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>)
  expect(
    migrated.groups[BUILTIN_SOURCE_ID].g2.segments.find((s) => s.id === 'level')?.category,
  ).toBe('battery')
})

test('migrate: 不正な category / tags を sanitize する', () => {
  const cfg = emptyConfig()
  syncSourceWithStatus(cfg, BUILTIN_SOURCE_ID, g2Doc(['level']))
  const sm = cfg.groups[BUILTIN_SOURCE_ID].g2.segments[0] as { category?: unknown; tags?: unknown }
  sm.category = 123 // 非文字列 → defaultCategory で battery に矯正
  sm.tags = ['a', 'a', '', 1, 'b'] // 重複/空/非文字列を除去
  const migrated = migrate(JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>)
  const out = migrated.groups[BUILTIN_SOURCE_ID].g2.segments[0]
  expect(out.category).toBe('battery')
  expect(out.tags).toEqual(['a', 'b'])
})

test('migrate 冪等: category backfill を二度かけても安定', () => {
  const cfg = emptyConfig()
  syncSourceWithStatus(cfg, BUILTIN_SOURCE_ID, g2Doc(['level']))
  const once = migrate(JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>)
  const twice = migrate(JSON.parse(JSON.stringify(once)) as Record<string, unknown>)
  expect(twice.groups[BUILTIN_SOURCE_ID].g2.segments.find((s) => s.id === 'level')?.category).toBe(
    'battery',
  )
})

test('syncSourceWithStatus: places(group nav) の segment に正しい category を seed する', () => {
  // places の group id は 'nav' (PLACES_GROUP_ID)。taxonomy キーが 'places' だと here/地点が custom に落ちる。
  const cfg = emptyConfig()
  const doc = {
    version: 1,
    ts: 0,
    groups: [
      {
        id: PLACES_GROUP_ID,
        label: 'Places',
        segments: [
          { id: 'here', label: 'At', value: 'Home' },
          { id: 'pl_abc12345', label: 'Home', value: '2km' },
        ],
      },
    ],
  }
  syncSourceWithStatus(cfg, PLACES_SOURCE_ID, doc as unknown as StatusDoc)
  const segs = cfg.groups[PLACES_SOURCE_ID][PLACES_GROUP_ID].segments
  expect(segs.find((s) => s.id === 'here')?.category).toBe('place_geofence')
  expect(segs.find((s) => s.id === 'pl_abc12345')?.category).toBe('place_distance')
})

test('migrate(v3 単発): server segment に category が seed される', () => {
  // v3/legacy 経路も migrateV4Same と同じ normalizeDisplayMeta を通す (単発 migrate で穴を作らない)。
  const v3 = {
    version: 3,
    sources: [{ id: 'server.a', kind: 'server', label: 'A', url: 'http://a.local/api/status' }],
    groups: { 'server.a': { system: { segments: [{ id: 'cpu' }, { id: 'battery' }] } } },
    groupOrder: [{ sourceId: 'server.a', groupId: 'system' }],
  }
  const cfg = migrate(v3 as unknown as Record<string, unknown>)
  const segs = cfg.groups['server.a'].system.segments
  expect(segs.find((s) => s.id === 'cpu')?.category).toBe('cpu_percent')
  expect(segs.find((s) => s.id === 'battery')?.category).toBe('battery')
})

test('migrate: 旧 mac group は system へ rename 後に category が付く (seed 順序)', () => {
  // 旧 config(OD-1 前)の system provider は group id 'mac' で category 未設定。
  // category seed が group rename の「前」に走ると 'mac|cpu' が引けず custom に誤確定する。
  // 順序(rename 後に seed)が正しいことを検証する。
  const cfg = emptyConfig()
  const s = addServer(cfg, 'Local', 'http://x.local/api/status')
  const prof = activeProfile(cfg)
  cfg.groups[s.id] = {
    mac: { segments: [{ id: 'cpu' }, { id: 'battery' }, { id: 'disk' }] },
  }
  prof.view.groups[s.id] = {
    mac: { enabled: true, segments: { cpu: true, battery: true, disk: true } },
  }
  prof.view.groupOrder.push({ sourceId: s.id, groupId: 'mac' })
  const migrated = migrate(JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>)
  const sys = migrated.groups[s.id].system
  expect(sys).toBeDefined()
  expect(sys.segments.find((x) => x.id === 'cpu')?.category).toBe('cpu_percent')
  expect(sys.segments.find((x) => x.id === 'battery')?.category).toBe('battery')
  expect(sys.segments.find((x) => x.id === 'disk')?.category).toBe('disk_free')
  expect(migrated.groups[s.id].mac).toBeUndefined() // 旧 group は消える
})
