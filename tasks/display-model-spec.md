# 表示モデル仕様: 同系統データ衝突の解消 (category / displayOwner / displayLabel / tags)

状態: ドラフト (実装前)。
背景の意思決定はメモリ `eveng2-display-model-design` 参照。
本書は会話 + codex(gpt5.5) 3往復 + 類似サービス調査 + コード接地マッピング(6並列)を統合した実装仕様。

## 1. 問題

実験的に source を増やした結果、異なる source の同系統データが並ぶと区別できない。
- グラス電池 `g2.level`("Bat 82%") と PC 電池 `system.battery`("Bat 78%") が同じ見た目。
- percent 系が大量(g2.level / system.cpu,mem,battery,disk / codex.5h,weekly / airquality.aqi)。
- 制約: 実機は ASCII のみ(色/アイコン/絵文字 不可)、1行〜50桁・最大10行(`MAX_ROWS=10`)。

## 2. 設計モデル (確定)

内部 identity と表示 identity を分離する。`group 名の任意前置`だけに頼ると衝突が再発するため。

```
内部 identity : sourceId > groupId > segmentId        (一意・不変。wire/status の責務)
表示 identity : category(単一leaf・必須) + displayOwner(source側) + displayLabel(静的)
横断メタ      : tags[]   (任意・多対多。フィルタ/preset自動化の裏軸。identityでも表示主軸でもない)
taxonomy     : category -> parent  (Power<-Battery を導出。segmentはleaf単一を選ぶ)
```

出自軸(owner)と種類軸(category)は直交する別軸。1本の木にすると同一 owner の同 category(例 Mac の battery が2つ)で破綻する。
最も近い実証先例は Home Assistant: area/device 階層 ⊥ label(tag)、`friendly_name = "{device} {entity}"` 自動合成、`device_class` で種類を標準語彙化。
category 語彙は HA `device_class` を下敷きにする。

### 責務分界 (エージェント間で割れた点の決着)

category / displayOwner / displayLabel / tags は config 専有メタデータ(`SegMeta` / `SourceDef`、ユーザー編集可・永続)。
wire の `Segment`(`src/status-types.ts:10`) は変更しない。producer は値のみ返す。
理由: プロトコル安定、producer は分類を知らない、glass の動的 prefix 判定を排除して静的描画にするため(状態依存バグ回避)。

## 3. Phase 分割

| Phase | 内容 | 既定での挙動 |
|---|---|---|
| 1 (本書の主対象) | スキーマ追加 + taxonomy 既定テーブル + seed/normalize。**何も新フィールドを読まない**ので描画は完全に現状維持 | 不変 |
| 2 | companion のカテゴリ整列ビュー(並行レンダラ) + owner バッジ + displayOwner リネーム UI + 衝突検知→displayLabel 焼込保存 | companion のみ変化 |
| 3 | glass を displayLabel 静的描画へ切替(group ラベル前置 dedup を撤去) + tag フィルタ UI | glass も変化 |

## 4. Phase 1 詳細仕様

### 4.1 型変更 (`src/config.ts`)

`SegMeta`(現 95-100行)に追加:

```typescript
export type SegMeta = {
  id: string
  format?: string
  options?: OptionValues
  visibility?: VisibilityCond
  category?: string        // 追加: device_class ベースの leaf 語彙(例 'battery','temperature')。素材=profile非依存
  displayLabel?: string    // 追加: 衝突時に焼き込む静的ラベル(Phase3 で glass が読む。Phase1 は書かない)
  tags?: string[]          // 追加: 横断フィルタ/preset自動化の裏軸(Phase2 で語彙確定。Phase1 は producer 出力なし)
}
```

`SourceDef`(現 81-89行)に追加:

```typescript
export type SourceDef = {
  id: string
  kind: SourceKind
  label: string
  url?: string
  urls: string[]
  machineId?: string
  options?: OptionValues
  displayOwner?: string    // 追加: 表示用オーナー(例 'Glass','Mac')。owner バッジ/prefix に使う(Phase2)
}
```

全て optional。`ViewGroup` / wire `Segment` / `GroupMeta` は変更しない。
`category` を「必須」と呼ぶのは意味上の話で、型は optional のまま(未設定= seed 既定で埋める)。これで既存 config が型エラーにならない。

### 4.2 既定 taxonomy テーブル (新規 `src/taxonomy.ts`)

server は値のみ返す方針なので、分類辞書はクライアント側(`src/`)に1か所持つ。
キーは `groupId|segId`(builtin/client/server-builtin の groupId は安定。user 追加 server の未知 group は fallback)。

```typescript
// leaf -> parent(taxonomy 1層)
export const CATEGORY_PARENT: Record<string, string> = {
  battery: 'power', power_rate: 'power',
  cpu_percent: 'system', memory_percent: 'system', disk_free: 'system',
  usage_percent: 'usage', counter: 'usage', energy_cost: 'usage',
  temperature: 'weather', feels_like: 'weather', humidity: 'weather',
  wind_speed: 'weather', wind_direction: 'weather', precipitation: 'weather',
  precipitation_chance: 'weather', pressure: 'weather', pressure_trend: 'weather',
  uv_index: 'weather', weather_code: 'weather',
  sunrise: 'astro', sunset: 'astro', daylength: 'astro', countdown: 'astro',
  aqi: 'air', pm25: 'air', pm10: 'air', pollen: 'air',
  elevation: 'location', timezone: 'location', timezone_offset: 'location',
  place_city: 'location', place_area: 'location', place_region: 'location',
  place_country: 'location', place_distance: 'location', place_geofence: 'location',
  timestamp: 'time', duration: 'time',
}

// groupId|segId -> leaf category。動的 places は resolver で吸収。
export const DEFAULT_CATEGORY: Record<string, string> = {
  'clock|datetime': 'timestamp',
  'g2|level': 'battery', 'g2|rate': 'power_rate', 'g2|eta': 'duration',
  'claude-code|cost': 'energy_cost', 'claude-code|msgs': 'counter',
  'codex|5h': 'usage_percent', 'codex|weekly': 'usage_percent',
  'system|cpu': 'cpu_percent', 'system|mem': 'memory_percent',
  'system|battery': 'battery', 'system|disk': 'disk_free',
  'weather|temp': 'temperature', 'weather|cond': 'weather_code',
  'weather|wind': 'wind_speed', 'weather|rainin': 'precipitation',
  'weather|pop1h': 'precipitation_chance', 'weather|precip1h': 'precipitation',
  'weather|feels': 'feels_like', 'weather|humid': 'humidity',
  'weather|wdir': 'wind_direction', 'weather|uv': 'uv_index',
  'weather|pres': 'pressure', 'weather|ptrend': 'pressure_trend',
  'weather|sunrise': 'sunrise', 'weather|sunset': 'sunset',
  'weather|daylength': 'daylength', 'weather|suncountdown': 'countdown',
  'geoinfo|elev': 'elevation', 'geoinfo|tz': 'timezone_offset', 'geoinfo|zone': 'timezone',
  'airquality|aqi': 'aqi', 'airquality|pm25': 'pm25',
  'airquality|pm10': 'pm10', 'airquality|pollen': 'pollen',
  'geocode|city': 'place_city', 'geocode|area': 'place_area',
  'geocode|region': 'place_region', 'geocode|country': 'place_country',
  'nav|here': 'place_geofence', // places の group id は PLACES_GROUP_ID = 'nav' ('places' ではない)
}

// groupId,segId から leaf を解決。places(group='nav')の動的 {placeId}(id=pl_xxxx)は place_distance、未知は 'custom'。
// config を import すると config→taxonomy の循環になるので 'nav' は literal で持つ(test が実 id で pin)。
export function defaultCategory(groupId: string, segId: string): string {
  const hit = DEFAULT_CATEGORY[`${groupId}|${segId}`]
  if (hit) return hit
  if (groupId === 'nav') return 'place_distance' // PLACES_GROUP_ID
  return 'custom'
}
```

segment id は providers-taxonomy のコード裏取り済み(全 46 segment)。
codex は実コードで `5h`/`weekly`(会話初出の「primary/secondary」は古い)。

### 4.3 seed と migration (`src/config.ts`)

CONFIG_VERSION は 4 据え置き(additive・optional フィールドなのでスキーマ bump 不要)。
`app.json` の version のみ実機反映のため bump(メモリ `eveng2-datasource-presets` の config bump の罠)。

(a) 新規 segment 素材化時に category を seed。`syncSourceWithStatus`(現 1529行):

```typescript
// before
gm.segments.push({ id: seg.id })
// after
gm.segments.push({ id: seg.id, category: defaultCategory(g.id, seg.id) })
```

(b) 既存 config の backfill + sanitize。3本を `normalizeDisplayMeta(c)` ヘルパにまとめ、全 migrate 経路から呼ぶ:

```typescript
function normalizeDisplayMeta(c: Config): void {
  normalizeMetaCategoryAll(c)    // 既存 SegMeta に category 未設定があれば defaultCategory で補充、不正値は除去
  normalizeSourceDisplayOwner(c) // displayOwner の不正値除去(seed は Phase2。Phase1 は型のみ)
  normalizeTagsAll(c)            // tags の重複/長さ sanitize(Phase1 は基本 [] / undefined)
}
```

呼び出し位置(重要・順序制約): `migrateV4Same` は `migrateMacGroupToSystem`(mac→system)+`consolidateClock`(clock 統合)の「後」、`pruneOrphans` の前。
`migrateV3ToV4` は `consolidateClock` の後、`migrateLegacyToV4` は `normalizeProfileView` の後(いずれも `pruneOrphans` 前)。
group id remap より前に走らせると旧 group id でキーが引けず custom に誤確定し、文字列ゆえ二度と矯正されない。
v3/legacy 経路にも入れることで「単発 migrate で category 未 seed」の穴を塞ぐ(spec の不変条件「migrate 後は常に category が付く」を全経路で満たす)。

`normalizeMetaCategoryAll` は `groups[*][groupId].segments` を走査し、`sm.category` が未設定/非文字列/空なら `defaultCategory(groupId, sm.id)` を入れる。
これで本変更前に素材化済みの segment にも category が付く。

(c) displayOwner の seed は Phase 1 では最小限。
`g2`(コード所有・主要衝突源)のみ `ensureBuiltin` で `displayOwner='Glass'` を source に注入してよい。
それ以外の owner 既定は Phase 2(バッジ UI と衝突検知が値を消費する時点)で決める。Phase 1 は型と sanitize のみ。

### 4.4 不変条件 (Phase 1 で挙動が変わらない保証)

- glass(`glass-render.ts`)・companion の Items 描画は新フィールドを一切読まない。
- `category`/`displayOwner`/`displayLabel`/`tags` は全て optional + 既定挙動が undefined 相当。
- SortableJS の index 整合(`.src-metrics` は segment 直接子のみ。`companion.ts` の onSegReorder)は触らない。
- producer(builtin/server/client)の出力は不変。

### 4.5 テスト

- 既存スナップショット/描画テストが全て無変更で通る(挙動不変の証明)。
- `defaultCategory` 単体: 46 既知 segment と places 動的 + 未知 → 'custom'。
- migration 冪等: 旧 config(category なし)→ migrate → 全 segment に category、再 migrate で差分なし。
- `config.test.ts` に category backfill ケースを追加。

## 5. Phase 2 概要 (companion)

- 並行レンダラ `renderItemsByCategory()` を新設し、既存 `renderItems()`(groupOrder 順)はトグルで残す。
  並べ替えの index 整合(`onSegReorder` は groupId 抽出 → meta.segments を直接入替)を壊さないため、置換ではなく併設。
- owner バッジ: `groupRow` の `.src-head`、`src-name` 直後に `[Glass]`/`[Mac]`。クリックで displayOwner inline 編集(source は profile 非依存=全 profile 反映)。
- 衝突検知: 同一 category leaf を複数 displayOwner が出すペア(主: `battery` の Glass vs Mac/PC)を検出し、`displayLabel = "{owner} {label}"` を生成して `saveConfig`。非衝突 segment は label のまま。owner prefix 既定 ON は冗長なので不採用。

## 6. Phase 3 概要 (glass)

- `renderKeys`(`glass-render.ts:160`)と `groupLine`(:121)を「`displayLabel` があればそれ、無ければ `label`」に統一。
  現在の group ラベル前置(`showsGroupLabel`/`groupLabelText` + `prevGroup` dedup)を撤去(owner は displayLabel に焼込済)。
- glass に衝突判定ロジックは無い(現状確認済み)。静的描画のまま。撤去対象は group ラベル前置のみ。
- 長文 displayLabel は幅圧迫(summary は word wrap で行増、custom は gap 減)。companion 保存時に長さ guidance を出す。
- tag フィルタ UI を advanced/詳細に集約。`tags` は表示主軸にしない。`visibility` leaf に `hasTag` は足さず別軸のまま(filter/suggest が `tags` を読む)。

## 7. 未確定 (要判断)

1. tags フィールドを Phase 1 で型だけ入れる(本書の既定)か、Phase 3 まで型ごと遅らせるか。
   - 入れる利点: 後で型を再度触らない。コスト: 使われない optional フィールドが1つ増える。
2. category taxonomy 語彙の最終確定。HA device_class をどこまで借りるか(本書は leaf 約40+parent 8 を提案)。
3. server `system` の displayOwner 既定(Mac/PC はホスト依存でクライアントが知らない)。source.label 由来にするか、Phase 2 でユーザー入力必須にするか。

## 8. 変更ファイル一覧 (Phase 1)

| ファイル | 変更 |
|---|---|
| `src/config.ts` | `SegMeta`(+category/displayLabel/tags)・`SourceDef`(+displayOwner)。`migrateV4Same` に normalize 3本追加。`syncSourceWithStatus`(1529) で category seed。`ensureBuiltin` で g2 owner=Glass |
| `src/taxonomy.ts` | 新規。`CATEGORY_PARENT` / `DEFAULT_CATEGORY` / `defaultCategory()` |
| `src/config.test.ts` | category backfill / 冪等 / defaultCategory のテスト |
| `app.json` | version bump(実機反映用) |

wire `Segment`(`src/status-types.ts`)・`glass-render.ts`・`companion.ts`・各 provider は Phase 1 では無変更。
