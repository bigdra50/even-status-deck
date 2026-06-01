// 表示モデルの「種類(category)」既定 taxonomy。仕様は tasks/display-model-spec.md。
// 同系統データ衝突(例: グラス電池 g2.level と PC 電池 system.battery が両方 'Bat')を解くため、
// segment を device_class(Home Assistant 準拠)ベースの leaf category に分類する。
//
// 設計上の住み分け:
// - 内部 identity = sourceId > groupId > segmentId(producer 由来・不変)。
// - category は config 専有メタ(SegMeta.category)。producer は値のみ返し、分類は知らない。
// - キーは groupId|segId。builtin/client/server-builtin の groupId は安定なので sourceId に依らず引ける。
// - parent(Power<-Battery)は consumer(Phase2 の companion カテゴリ整列)が要るまで導入しない(YAGNI)。

// groupId|segId -> leaf category。動的 segment(places の保存地点)と未知 source は defaultCategory で吸収。
const DEFAULT_CATEGORY: Record<string, string> = {
  // builtin (Device)
  'clock|datetime': 'timestamp',
  'g2|level': 'battery',
  'g2|rate': 'power_rate',
  'g2|eta': 'duration',
  // server.local (Local)
  'claude-code|cost': 'energy_cost',
  'claude-code|msgs': 'counter',
  'codex|5h': 'usage_percent',
  'codex|weekly': 'usage_percent',
  'system|cpu': 'cpu_percent',
  'system|mem': 'memory_percent',
  'system|battery': 'battery',
  'system|disk': 'disk_free',
  // client.weather (Weather)
  'weather|temp': 'temperature',
  'weather|cond': 'weather_code',
  'weather|wind': 'wind_speed',
  'weather|rainin': 'precipitation',
  'weather|pop1h': 'precipitation_chance',
  'weather|precip1h': 'precipitation',
  'weather|feels': 'feels_like',
  'weather|humid': 'humidity',
  'weather|wdir': 'wind_direction',
  'weather|uv': 'uv_index',
  'weather|pres': 'pressure',
  'weather|ptrend': 'pressure_trend',
  'weather|sunrise': 'sunrise',
  'weather|sunset': 'sunset',
  'weather|daylength': 'daylength',
  'weather|suncountdown': 'countdown',
  // client.geoinfo (Location)
  'geoinfo|elev': 'elevation',
  'geoinfo|tz': 'timezone_offset',
  'geoinfo|zone': 'timezone',
  // client.airquality (Air)
  'airquality|aqi': 'aqi',
  'airquality|pm25': 'pm25',
  'airquality|pm10': 'pm10',
  'airquality|pollen': 'pollen',
  // client.geocode (Place)
  'geocode|city': 'place_city',
  'geocode|area': 'place_area',
  'geocode|region': 'place_region',
  'geocode|country': 'place_country',
  // client.places (Places)。group id は PLACES_GROUP_ID = 'nav' (config.ts。'places' ではない)。
  // config を import すると config→taxonomy の逆向き循環になるため literal で持つ (test が実 id で pin)。
  'nav|here': 'place_geofence',
}

// groupId,segId から既定 leaf category を解決する。
// places(group id='nav')の動的 segment(保存地点ごと id=pl_xxxx)は place_distance、未知は 'custom'。
export function defaultCategory(groupId: string, segId: string): string {
  const hit = DEFAULT_CATEGORY[`${groupId}|${segId}`]
  if (hit) return hit
  if (groupId === 'nav') return 'place_distance' // PLACES_GROUP_ID (config.ts)
  return 'custom'
}
