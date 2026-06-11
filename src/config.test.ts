// config 移行の回帰テスト。client source(weather/geoinfo 等)は opt-in なので、旧 config の升級で
// 既定 ON にしてはいけない(さもないと位置許可ダイアログ/外部 fetch が升級だけで走る)。
// 実行: bun test src/config.test.ts
import { expect, test } from 'bun:test'
import {
  activeProfile,
  addProfile,
  addServer,
  BUILTIN_SOURCE_ID,
  DEFAULT_PROFILE_ID,
  duplicateActiveProfile,
  emptyConfig,
  LOCATION_PLACE_GROUP_ID,
  LOCATION_SOURCE_ID,
  migrate,
  promoteSourceUrl,
  removeSourceUrl,
  resolvePages,
  type SourceDef,
  setActiveProfile,
  setSourceUrls,
  sourceUrls,
  syncSourceWithStatus,
} from './config'
import type { StatusDoc } from './status-types'

// URL 管理 helper 用の最小 server SourceDef。
function serverSrc(urls: string[], url?: string): SourceDef {
  return { id: 's', kind: 'server', label: 'x', urls, ...(url ? { url } : {}) }
}

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

test('migrate(v3): client source は enabledSourceIds に入れない(opt-in 維持)', () => {
  const v3 = {
    version: 3,
    sources: [{ id: 'server.a', kind: 'server', label: 'A', url: 'http://a.local/api/status' }],
    groups: {},
    groupOrder: [],
  }
  const cfg = migrate(v3 as unknown as Record<string, unknown>)
  // 統合 client.location source は素材としては存在する(Add source で出せる)
  expect(cfg.sources.some((s) => s.id === LOCATION_SOURCE_ID)).toBe(true)
  // が、Default profile では有効化されない(server.a は有効、client は無効=opt-in)
  const enabled = activeProfile(cfg).enabledSourceIds
  expect(enabled).toContain('server.a')
  expect(enabled).not.toContain(LOCATION_SOURCE_ID)
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
  expect(enabled).not.toContain(LOCATION_SOURCE_ID)
})

// ── 位置 source 統合 migration (旧 5 source → client.location 2 group) ──
// 旧 v4 構成(weather/airquality/geocode/geoinfo/places が別 source)を 1 source 2 group へ畳む。
function legacyLocationV4(): Record<string, unknown> {
  return {
    version: 4,
    sources: [
      { id: 'builtin.local', kind: 'builtin', label: 'Device', urls: [] },
      { id: 'server.a', kind: 'server', label: 'A', urls: ['http://a.local/api/status'] },
      {
        id: 'client.weather',
        kind: 'client',
        label: 'Weather',
        urls: [],
        options: { tempUnit: 'F' },
      },
      { id: 'client.airquality', kind: 'client', label: 'Air', urls: [] },
      { id: 'client.geocode', kind: 'client', label: 'Place', urls: [] },
      {
        id: 'client.geoinfo',
        kind: 'client',
        label: 'Location',
        urls: [],
        options: { elevUnit: 'ft' },
      },
      { id: 'client.places', kind: 'client', label: 'Places', urls: [] },
    ],
    groups: {
      'client.weather': { weather: { segments: [{ id: 'temp' }, { id: 'cond' }] } },
      'client.airquality': { airquality: { segments: [{ id: 'aqi' }, { id: 'pm25' }] } },
      'client.geocode': { geocode: { segments: [{ id: 'city' }] } },
      'client.geoinfo': { geoinfo: { segments: [{ id: 'elev' }] } },
      'client.places': { nav: { segments: [{ id: 'here' }, { id: 'pl_x' }] } },
    },
    profiles: [
      {
        id: 'default',
        name: 'Default',
        // weather/geocode 有効、airquality/geoinfo/places 無効。
        enabledSourceIds: ['builtin.local', 'server.a', 'client.weather', 'client.geocode'],
        view: {
          groups: {
            'client.weather': { weather: { enabled: true, segments: { temp: true, cond: true } } },
            'client.airquality': {
              airquality: { enabled: true, segments: { aqi: true, pm25: true } },
            },
            'client.geocode': { geocode: { enabled: true, segments: { city: true } } },
            'client.geoinfo': { geoinfo: { enabled: true, segments: { elev: true } } },
            'client.places': { nav: { enabled: true, segments: { here: true, pl_x: true } } },
          },
          groupOrder: [
            { sourceId: 'client.weather', groupId: 'weather' },
            { sourceId: 'client.airquality', groupId: 'airquality' },
            { sourceId: 'client.geocode', groupId: 'geocode' },
            { sourceId: 'client.geoinfo', groupId: 'geoinfo' },
            { sourceId: 'client.places', groupId: 'nav' },
          ],
          glassLayout: {
            rows: [
              [
                'client.weather|weather|temp',
                'client.airquality|airquality|aqi',
                '@right',
                'client.geocode|geocode|city',
              ],
            ],
          },
        },
      },
    ],
    activeProfileId: 'default',
  }
}

test('migrate: 旧 5 location source を client.location(2 group) へ畳む', () => {
  const cfg = migrate(legacyLocationV4())
  // 旧 5 source は消え client.location 1 つに。
  for (const oldId of [
    'client.weather',
    'client.airquality',
    'client.geocode',
    'client.geoinfo',
    'client.places',
  ]) {
    expect(cfg.sources.some((s) => s.id === oldId)).toBe(false)
  }
  expect(cfg.sources.filter((s) => s.kind === 'client').map((s) => s.id)).toEqual([
    LOCATION_SOURCE_ID,
  ])
  // 素材: weather group = 旧 weather + 旧 air。place group = 旧 geocode + geoinfo
  // (旧 nav の here/pl_x は距離ナビ撤廃 migrateDropPlaceNav で除去済 #42)。
  const g = cfg.groups[LOCATION_SOURCE_ID]
  expect(g.weather.segments.map((s) => s.id).sort()).toEqual(['aqi', 'cond', 'pm25', 'temp'])
  expect(g.place.segments.map((s) => s.id).sort()).toEqual(['city', 'elev'])
  // options は union でマージ。
  const loc = cfg.sources.find((s) => s.id === LOCATION_SOURCE_ID)
  expect(loc?.options?.tempUnit).toBe('F')
  expect(loc?.options?.elevUnit).toBe('ft')
})

test('migrate: enabled は旧→client.location へ集約、disabled 由来 segment は復活させない', () => {
  const cfg = migrate(legacyLocationV4())
  const prof = activeProfile(cfg)
  // 旧のどれか有効 → client.location が enabled、旧 client.* は消える。
  expect(prof.enabledSourceIds).toContain(LOCATION_SOURCE_ID)
  expect(prof.enabledSourceIds.filter((id) => id.startsWith('client.'))).toEqual([
    LOCATION_SOURCE_ID,
  ])
  const vw = prof.view.groups[LOCATION_SOURCE_ID]
  // weather group: temp/cond は表示(weather 有効)、aqi/pm25 は false(airquality 無効だった=復活防止)。
  expect(vw.weather.segments.temp).toBe(true)
  expect(vw.weather.segments.cond).toBe(true)
  expect(vw.weather.segments.aqi).toBe(false)
  expect(vw.weather.segments.pm25).toBe(false)
  // place group: city は表示(geocode 有効)、elev は false(geoinfo 無効だった)。
  // here/pl_x(旧 nav)は距離ナビ撤廃(migrateDropPlaceNav)で view からも除去される。
  expect(vw.place.segments.city).toBe(true)
  expect(vw.place.segments.elev).toBe(false)
  expect(vw.place.segments.here).toBeUndefined()
  expect(vw.place.segments.pl_x).toBeUndefined()
})

test('migrate: groupOrder/glassLayout を sourceId+groupId remap & dedupe (＠right 保持)', () => {
  const cfg = migrate(legacyLocationV4())
  const prof = activeProfile(cfg)
  // groupOrder: 旧 5 ref が client.location|weather, client.location|place に dedupe。
  expect(
    prof.view.groupOrder.filter((r) => r.sourceId === LOCATION_SOURCE_ID).map((r) => r.groupId),
  ).toEqual(['weather', 'place'])
  // glassLayout: segKey の sourceId+groupId remap、@right は素通し。
  expect(prof.view.glassLayout?.rows[0]).toEqual([
    'client.location|weather|temp',
    'client.location|weather|aqi',
    '@right',
    'client.location|place|city',
  ])
})

test('migrate: 統合は冪等 (2 回流しても client.location 1 つ・group 2 つ)', () => {
  const once = migrate(legacyLocationV4())
  const twice = migrate(JSON.parse(JSON.stringify(once)) as Record<string, unknown>)
  expect(twice.sources.filter((s) => s.kind === 'client').map((s) => s.id)).toEqual([
    LOCATION_SOURCE_ID,
  ])
  expect(Object.keys(twice.groups[LOCATION_SOURCE_ID]).sort()).toEqual(['place', 'weather'])
  expect(twice.groups[LOCATION_SOURCE_ID].weather.segments.map((s) => s.id).sort()).toEqual([
    'aqi',
    'cond',
    'pm25',
    'temp',
  ])
})

// ── 距離/方位ナビ(#42)撤廃 + 保存地点/geofence(#43)撤去 migration ──
// migrateDropPlaceNav: 統合済 client.location の place group に焼かれた nav 動的 segment(pl_xxxx)と
// presence(here)を素材・view・glassLayout から除去する。
// cleanupPlacesGeofence: places / profile.geofence の残骸を削除。inPlace visibility 条件は
// sanitizeLeaf が未知 kind を落とすことで自動 drop される(単独なら visibility ごと undefined=常時表示)。
function locationV4WithNav(): Record<string, unknown> {
  return {
    version: 4,
    sources: [
      { id: 'builtin.local', kind: 'builtin', label: 'Device', urls: [] },
      { id: 'server.x', kind: 'server', label: 'X', urls: ['http://x.local/api/status'] },
      {
        id: LOCATION_SOURCE_ID,
        kind: 'client',
        label: 'Location',
        urls: [],
        origin: 'app_bundled',
        options: { tempUnit: 'F', distUnit: 'mi', bearingStyle: 'arrow' },
      },
    ],
    places: [{ id: 'pl_home', label: 'Home', lat: 35, lon: 139, radiusM: 150 }],
    groups: {
      [LOCATION_SOURCE_ID]: {
        weather: { segments: [{ id: 'temp' }] },
        place: { segments: [{ id: 'city' }, { id: 'elev' }, { id: 'here' }, { id: 'pl_home' }] },
      },
      'server.x': {
        g: {
          segments: [
            {
              id: 's1',
              visibility: {
                combinator: 'and',
                conditions: [{ kind: 'inPlace', placeId: 'pl_home' }],
              },
            },
            {
              id: 's2',
              visibility: {
                combinator: 'and',
                conditions: [
                  { kind: 'inPlace', placeId: 'pl_home' },
                  { kind: 'threshold', op: 'gte', value: 50 },
                ],
              },
            },
          ],
        },
      },
    },
    profiles: [
      {
        id: 'default',
        name: 'Default',
        enabledSourceIds: ['builtin.local', 'server.x', LOCATION_SOURCE_ID],
        geofence: { placeId: 'pl_home', mode: 'auto' },
        view: {
          groups: {
            [LOCATION_SOURCE_ID]: {
              weather: { enabled: true, segments: { temp: true } },
              place: {
                enabled: true,
                segments: { city: true, elev: true, here: false, pl_home: true },
              },
            },
          },
          groupOrder: [{ sourceId: LOCATION_SOURCE_ID, groupId: 'place' }],
          glassLayout: {
            rows: [
              [`${LOCATION_SOURCE_ID}|place|city`, `${LOCATION_SOURCE_ID}|place|pl_home`],
              [`${LOCATION_SOURCE_ID}|place|here`, 'builtin.local|clock|datetime'],
            ],
          },
        },
      },
    ],
    activeProfileId: 'default',
  }
}

test('migrate: 距離ナビ撤廃 — place group の pl_xxxx/here を素材/view/glassLayout から除去', () => {
  const cfg = migrate(locationV4WithNav())
  const g = cfg.groups[LOCATION_SOURCE_ID]
  // 素材: 地名/標高は残り、nav(here/pl_home)は消える。
  expect(g.place.segments.map((s) => s.id).sort()).toEqual(['city', 'elev'])
  const vw = activeProfile(cfg).view.groups[LOCATION_SOURCE_ID]
  expect(vw.place.segments.city).toBe(true)
  expect(vw.place.segments.elev).toBe(true)
  expect(vw.place.segments.here).toBeUndefined()
  expect(vw.place.segments.pl_home).toBeUndefined()
  // glassLayout: nav chip(pl_home/here)だけ除去、他 chip(city/clock)は保つ(空行は残す)。
  const rows = activeProfile(cfg).view.glassLayout?.rows
  expect(rows?.[0]).toEqual([`${LOCATION_SOURCE_ID}|place|city`])
  expect(rows?.[1]).toEqual(['builtin.local|clock|datetime'])
  // 廃止オプション値は掃除、weather 系は残す。
  const loc = cfg.sources.find((s) => s.id === LOCATION_SOURCE_ID)
  expect(loc?.options?.tempUnit).toBe('F')
  expect(loc?.options?.distUnit).toBeUndefined()
  expect(loc?.options?.bearingStyle).toBeUndefined()
})

test('migrate: places/geofence/inPlace 残骸は撤去 cleanup で消える (#43 撤去)', () => {
  const cfg = migrate(locationV4WithNav())
  // 保存地点配列は削除される(機能撤去。型からも消えているので raw で確認)。
  expect((cfg as unknown as Record<string, unknown>).places).toBeUndefined()
  // profile の geofence 連動も解除される。
  expect((activeProfile(cfg) as unknown as Record<string, unknown>).geofence).toBeUndefined()
  const segs = cfg.groups['server.x'].g.segments
  // inPlace 単独条件は自動 drop → conditions 空 → visibility ごと undefined(常時表示へ fail-open)。
  expect(segs.find((s) => s.id === 's1')?.visibility).toBeUndefined()
  // inPlace + threshold 混合は inPlace だけ落ち、threshold は残る。
  expect(segs.find((s) => s.id === 's2')?.visibility?.conditions).toEqual([
    { kind: 'threshold', op: 'gte', value: 50 },
  ])
})

test('migrate: 距離ナビ撤廃 + places 撤去は冪等 (2 回流しても同じ)', () => {
  const once = migrate(locationV4WithNav())
  const twice = migrate(JSON.parse(JSON.stringify(once)) as Record<string, unknown>)
  expect(twice.groups[LOCATION_SOURCE_ID].place.segments.map((s) => s.id).sort()).toEqual([
    'city',
    'elev',
  ])
  expect((twice as unknown as Record<string, unknown>).places).toBeUndefined()
})

// ── builtin segment の静的 seed (companion Items が放電データ未蓄積でも rate/eta を設定可能に) ──

test('ensureBuiltin: g2 に level/rate/eta を静的 seed する', () => {
  const cfg = emptyConfig()
  const segs = cfg.groups[BUILTIN_SOURCE_ID].g2.segments
  expect(segs.map((s) => s.id)).toEqual(['level', 'rate', 'eta'])
  expect(segs.find((s) => s.id === 'rate')?.category).toBe('power_rate')
  expect(segs.find((s) => s.id === 'eta')?.category).toBe('duration')
  // builtin 2 group (clock/g2) が groupOrder 先頭に並ぶ
  const order = activeProfile(cfg).view.groupOrder.filter((r) => r.sourceId === BUILTIN_SOURCE_ID)
  expect(order.map((r) => r.groupId)).toEqual(['clock', 'g2'])
})

test('ensureBuiltin: seed は idempotent (migrate 再実行で重複しない)', () => {
  const cfg = migrate(JSON.parse(JSON.stringify(emptyConfig())) as Record<string, unknown>)
  const ids = cfg.groups[BUILTIN_SOURCE_ID].g2.segments.map((s) => s.id)
  expect(ids).toEqual(['level', 'rate', 'eta'])
})

test('ensureBuiltin: 既存 g2(level のみ)に rate/eta を後方補充する', () => {
  const cfg = emptyConfig()
  // 旧 sync 由来で level しか無い状態を再現
  cfg.groups[BUILTIN_SOURCE_ID].g2.segments = [{ id: 'level', category: 'battery' }]
  const migrated = migrate(JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>)
  expect(migrated.groups[BUILTIN_SOURCE_ID].g2.segments.map((s) => s.id)).toEqual([
    'level',
    'rate',
    'eta',
  ])
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

test('syncSourceWithStatus: place group の segment に正しい category を seed する', () => {
  // 統合後: place group は地名(geocode)+標高/TZ(geoinfo)。taxonomy キーが 'place|*' へ
  // 統合された取りこぼし回帰を pin する(距離/方位ナビ #42 は撤廃済=pl_xxxx/here は出ない)。
  const cfg = emptyConfig()
  const doc = {
    version: 1,
    ts: 0,
    groups: [
      {
        id: LOCATION_PLACE_GROUP_ID,
        label: 'Place',
        segments: [
          { id: 'city', label: 'City', value: 'Tokyo' },
          { id: 'elev', label: 'Elev', value: '40m' },
        ],
      },
    ],
  }
  syncSourceWithStatus(cfg, LOCATION_SOURCE_ID, doc as unknown as StatusDoc)
  const segs = cfg.groups[LOCATION_SOURCE_ID][LOCATION_PLACE_GROUP_ID].segments
  expect(segs.find((s) => s.id === 'city')?.category).toBe('place_city')
  expect(segs.find((s) => s.id === 'elev')?.category).toBe('elevation')
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

test('setSourceUrls: dedupe + legacy url を先頭に同期 + 空で url を落とす', () => {
  const s = serverSrc(['a', 'a', 'b'], 'a')
  setSourceUrls(s, ['b', 'b', 'c'])
  expect(s.urls).toEqual(['b', 'c'])
  expect(s.url).toBe('b') // legacy url は常に先頭経路に一致
  setSourceUrls(s, [])
  expect(s.urls).toEqual([])
  expect(s.url).toBeUndefined()
})

test('removeSourceUrl: legacy url を畳んで削除し stale な経路が再出現しない', () => {
  const s = serverSrc(['local'], 'lan') // url(lan) は urls に無い = sourceUrls() では末尾に畳まれる
  expect(sourceUrls(s)).toEqual(['local', 'lan'])
  removeSourceUrl(s, 'lan')
  expect(sourceUrls(s)).toEqual(['local']) // lan が url 経由で蘇らない
  expect(s.url).toBe('local')
})

test('promoteSourceUrl: 主経路へ昇格 / 存在しない経路は no-op', () => {
  const s = serverSrc(['ip', 'local'])
  promoteSourceUrl(s, 'local')
  expect(s.urls).toEqual(['local', 'ip'])
  expect(s.url).toBe('local')
  const before = [...s.urls]
  promoteSourceUrl(s, 'nope')
  expect(s.urls).toEqual(before)
})

// ── マルチページ (pages) 移行 (CONFIG_VERSION 4→5) ──

test('migrate v4→v5: glassLayout を pages[0] へ投影 (別オブジェクト)', () => {
  const v4 = emptyConfig()
  ;(v4 as { version: number }).version = 4
  const key = `${BUILTIN_SOURCE_ID}|g2|level`
  const rows = Array.from({ length: 10 }, () => [] as string[])
  rows[0] = [key]
  activeProfile(v4).view.glassLayout = { rows, customLabels: {} }
  const cfg = migrate(v4 as unknown as Record<string, unknown>)
  expect(cfg.version).toBe(5)
  const v = activeProfile(cfg).view
  expect(v.pages?.length).toBe(1)
  expect(v.pages?.[0]?.id).toBe('page-1')
  expect(v.pages?.[0]?.layout.rows[0]).toEqual([key])
  // 別オブジェクト: glassLayout を壊しても pages は無傷
  const lay = v.glassLayout
  if (lay) lay.rows[0] = []
  expect(v.pages?.[0]?.layout.rows[0]).toEqual([key])
})

test('migrate v5: pages の id/name 補完・壊れ layout 除去・冪等', () => {
  const cfg = emptyConfig()
  const key = `${BUILTIN_SOURCE_ID}|g2|level`
  const okRows = Array.from({ length: 10 }, () => [] as string[])
  okRows[0] = [key]
  ;(activeProfile(cfg).view as { pages: unknown }).pages = [
    { layout: { rows: okRows, customLabels: {} } }, // id/name 欠落 → 補完
    { id: 'p2', name: 'P2', layout: null }, // 壊れた layout → 除去
  ]
  const migrated = migrate(cfg as unknown as Record<string, unknown>)
  const pages = activeProfile(migrated).view.pages
  expect(pages?.length).toBe(1)
  expect(pages?.[0]?.id).toBe('page-1')
  expect(pages?.[0]?.name).toBe('Page 1')
  // 冪等: もう一度 migrate しても増減しない
  const again = migrate(migrated as unknown as Record<string, unknown>)
  expect(activeProfile(again).view.pages?.length).toBe(1)
})

test('resolvePages: pages 優先 / glassLayout 1 枚 / 両方無しは空', () => {
  const rows = Array.from({ length: 10 }, () => [] as string[])
  expect(resolvePages({ groups: {}, groupOrder: [] })).toEqual([])
  expect(
    resolvePages({ groups: {}, groupOrder: [], glassLayout: { rows, customLabels: {} } }),
  ).toHaveLength(1)
  const pages = [{ id: 'a', name: 'A', layout: { rows, customLabels: {} } }]
  expect(resolvePages({ groups: {}, groupOrder: [], pages })).toBe(pages)
})

test('duplicateActiveProfile: pages を deep copy (複製先編集が元に波及しない)', () => {
  const cfg = emptyConfig()
  const key = `${BUILTIN_SOURCE_ID}|g2|level`
  const rows = Array.from({ length: 10 }, () => [] as string[])
  rows[0] = [key]
  activeProfile(cfg).view.pages = [
    { id: 'p1', name: 'P1', layout: { rows, customLabels: { a: { text: 'X' } } } },
  ]
  const def = cfg.profiles[0]
  const dup = duplicateActiveProfile(cfg)
  const dpage = dup.view.pages?.[0]
  if (dpage) {
    dpage.layout.rows[0] = []
    dpage.layout.customLabels.a = { text: 'Y' }
  }
  expect(def?.view.pages?.[0]?.layout.rows[0]).toEqual([key])
  expect(def?.view.pages?.[0]?.layout.customLabels.a?.text).toBe('X')
})

test('migrate: pages[].layout の orphan source chip を掃除', () => {
  const cfg = emptyConfig()
  const validKey = `${BUILTIN_SOURCE_ID}|g2|level`
  const rows = Array.from({ length: 10 }, () => [] as string[])
  rows[0] = [validKey, 'ghost.source|grp|seg']
  activeProfile(cfg).view.pages = [{ id: 'p1', name: 'P1', layout: { rows, customLabels: {} } }]
  const migrated = migrate(cfg as unknown as Record<string, unknown>)
  expect(activeProfile(migrated).view.pages?.[0]?.layout.rows[0]).toEqual([validKey])
})

test('migrate: 非 active profile の pages も clock time/date を datetime へ畳む', () => {
  const cfg = emptyConfig()
  ;(cfg as { version: number }).version = 4
  const timeKey = `${BUILTIN_SOURCE_ID}|clock|time`
  const dtKey = `${BUILTIN_SOURCE_ID}|clock|datetime`
  const rows = Array.from({ length: 10 }, () => [] as string[])
  rows[0] = [timeKey]
  const p2 = addProfile(cfg, 'P2') // addProfile は active を P2 に変える
  p2.view.pages = [{ id: 'x', name: 'X', layout: { rows, customLabels: {} } }]
  setActiveProfile(cfg, DEFAULT_PROFILE_ID) // active を Default に戻す (p2 は非 active)
  const migrated = migrate(cfg as unknown as Record<string, unknown>)
  const p2m = migrated.profiles.find((p) => p.id === p2.id)
  expect(p2m?.view.pages?.[0]?.layout.rows[0]).toEqual([dtKey])
})

// ── group 見出しマージ移行: 旧 'auto' 衝突命名の一掃と lastLabel 捕捉 ──

// label 付き server group の最小 StatusDoc (lastLabel 捕捉テスト用)。
function labeledDoc(groupId: string, label: string): StatusDoc {
  return {
    version: 1,
    ts: 0,
    groups: [{ id: groupId, label, segments: [{ id: 'a', label: 'A', value: 'x' }] }],
  }
}

test('migrate: 旧 auto 衝突命名は displayName ごと一掃し user 命名は保全する', () => {
  const cfg = emptyConfig()
  const src = addServer(cfg, 'Mac')
  cfg.groups[src.id] = {
    'claude-limits': { segments: [], displayName: 'Claude (limits)', displayNameSource: 'auto' },
    'claude-code': { segments: [], displayName: 'My Claude', displayNameSource: 'user' },
    // 出所不明 (marker 無し) の displayName はユーザー命名として保全する
    system: { segments: [], displayName: 'Box' },
  }
  const migrated = migrate(JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>)
  const groups = migrated.groups[src.id]
  expect(groups['claude-limits']?.displayName).toBeUndefined()
  expect(groups['claude-code']?.displayName).toBe('My Claude')
  expect(groups.system?.displayName).toBe('Box')
  // 廃止フィールド displayNameSource は常に落とす
  for (const meta of Object.values(groups)) {
    expect((meta as { displayNameSource?: string }).displayNameSource).toBeUndefined()
  }
})

test('migrate 冪等: auto 一掃を二度かけても安定', () => {
  const cfg = emptyConfig()
  const src = addServer(cfg, 'Mac')
  cfg.groups[src.id] = {
    'claude-limits': { segments: [], displayName: 'Claude (limits)', displayNameSource: 'auto' },
    'claude-code': { segments: [], displayName: 'My Claude', displayNameSource: 'user' },
  }
  const once = migrate(JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>)
  const twice = migrate(JSON.parse(JSON.stringify(once)) as Record<string, unknown>)
  expect(twice.groups[src.id]?.['claude-limits']?.displayName).toBeUndefined()
  expect(twice.groups[src.id]?.['claude-code']?.displayName).toBe('My Claude')
})

test('migrate: 不正な lastLabel を sanitize する', () => {
  const cfg = emptyConfig()
  const src = addServer(cfg, 'Mac')
  cfg.groups[src.id] = {
    a: { segments: [], lastLabel: '' },
    b: { segments: [], lastLabel: 123 as unknown as string },
    c: { segments: [], lastLabel: 'Claude' },
  }
  const migrated = migrate(JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>)
  expect(migrated.groups[src.id]?.a?.lastLabel).toBeUndefined()
  expect(migrated.groups[src.id]?.b?.lastLabel).toBeUndefined()
  expect(migrated.groups[src.id]?.c?.lastLabel).toBe('Claude')
})

test('syncSourceWithStatus: live group label を lastLabel に捕捉する (再 sync は no-op)', () => {
  const cfg = emptyConfig()
  const src = addServer(cfg, 'Mac')
  expect(syncSourceWithStatus(cfg, src.id, labeledDoc('claude-limits', 'Claude'))).toBe(true)
  expect(cfg.groups[src.id]?.['claude-limits']?.lastLabel).toBe('Claude')
  // 同じ label の再 sync では変更なし (毎 poll saveConfig churn を起こさない)
  expect(syncSourceWithStatus(cfg, src.id, labeledDoc('claude-limits', 'Claude'))).toBe(false)
  // 空 label は記録しない (builtin 等の見出し無し group)
  syncSourceWithStatus(cfg, src.id, labeledDoc('nolabel', ''))
  expect(cfg.groups[src.id]?.nolabel?.lastLabel).toBeUndefined()
  // 非空→空への変化は lastLabel を削除 (旧見出しで誤マージし続けない)
  expect(syncSourceWithStatus(cfg, src.id, labeledDoc('claude-limits', ''))).toBe(true)
  expect(cfg.groups[src.id]?.['claude-limits']?.lastLabel).toBeUndefined()
  // 空のまま再 sync しても no-op
  expect(syncSourceWithStatus(cfg, src.id, labeledDoc('claude-limits', ''))).toBe(false)
})

// ── 定常状態 idempotence (#88 Phase 4 / #4): 構造不変の poll で saveConfig churn を起こさない ──

// 複数 segment (値が poll ごとに変わり得る) を持つ claude-limits group の StatusDoc。
function claudeLimitsDoc(values: { cost: string; msgs: string }): StatusDoc {
  return {
    version: 1,
    ts: Date.now(),
    groups: [
      {
        id: 'claude-limits',
        label: 'Claude',
        segments: [
          { id: 'cost', label: 'Cost', value: values.cost, percent: Number(values.cost) },
          { id: 'msgs', label: 'Msgs', value: values.msgs },
        ],
      },
    ],
  }
}

test('syncSourceWithStatus: 同一 doc を二回 sync しても 2 回目は false (構造不変 = no-op)', () => {
  const cfg = emptyConfig()
  const src = addServer(cfg, 'Mac')
  const doc = claudeLimitsDoc({ cost: '10', msgs: '5' })
  expect(syncSourceWithStatus(cfg, src.id, doc)).toBe(true) // 初回: group/segment 新規登録
  expect(syncSourceWithStatus(cfg, src.id, doc)).toBe(false) // 2 回目: 構造・lastLabel 不変
})

test('syncSourceWithStatus: segment の値だけが変化する poll は changed=false (構造/lastLabel 不変)', () => {
  const cfg = emptyConfig()
  const src = addServer(cfg, 'Mac')
  // 初回 sync で素材登録 (changed=true)
  expect(syncSourceWithStatus(cfg, src.id, claudeLimitsDoc({ cost: '10', msgs: '5' }))).toBe(true)
  // 値だけ変わる定常 poll を繰り返しても、構造/lastLabel が不変なら false (saveConfig churn 無し)
  expect(syncSourceWithStatus(cfg, src.id, claudeLimitsDoc({ cost: '11', msgs: '5' }))).toBe(false)
  expect(syncSourceWithStatus(cfg, src.id, claudeLimitsDoc({ cost: '99', msgs: '123' }))).toBe(
    false,
  )
  expect(syncSourceWithStatus(cfg, src.id, claudeLimitsDoc({ cost: '0', msgs: '0' }))).toBe(false)
})
