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
  // client.location group 'weather' (気象 + 大気質)。旧 client.weather + client.airquality を集約。
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
  'weather|aqi': 'aqi',
  'weather|pm25': 'pm25',
  'weather|pm10': 'pm10',
  'weather|pollen': 'pollen',
  // client.location group 'place' (地名 + 標高/TZ + 保存地点ナビ)。旧 geocode + geoinfo + places(nav) を集約。
  'place|city': 'place_city',
  'place|area': 'place_area',
  'place|region': 'place_region',
  'place|country': 'place_country',
  'place|elev': 'elevation',
  'place|tz': 'timezone_offset',
  'place|zone': 'timezone',
  'place|here': 'place_geofence',
}

// groupId,segId から既定 leaf category を解決する。
// place group の動的 segment(保存地点ごと id=pl_xxxx。LOCATION_PLACE_GROUP_ID)は place_distance、未知は 'custom'。
export function defaultCategory(groupId: string, segId: string): string {
  const hit = DEFAULT_CATEGORY[`${groupId}|${segId}`]
  if (hit) return hit
  if (groupId === 'place') return 'place_distance' // LOCATION_PLACE_GROUP_ID (config.ts)
  return 'custom'
}
