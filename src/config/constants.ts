export const CONFIG_VERSION = 5
export const BUILTIN_SOURCE_ID = 'builtin.local'
// 暗黙の既定サーバ (同一オリジン) の決定的 ID。起動毎にランダム ID で再追加すると groupOrder が
// 孤立蓄積するため、固定 ID にして二重 init / 再起動でも同一ソースに収束させる。
export const LOCAL_SOURCE_ID = 'server.local'
// 気象 client source の決定的 ID。位置は companion WebView の geolocation で取る(SDK に GPS 無し)。
export const WEATHER_SOURCE_ID = 'client.weather'
// 標高/タイムゾーン client source の決定的 ID (#45)。weather と同じ geolocation を使う別 source。
export const GEOINFO_SOURCE_ID = 'client.geoinfo'
// 空気質(AQI/PM/花粉) client source の決定的 ID (#41)。別ホスト(air-quality-api.open-meteo.com)を使う。
export const AIRQUALITY_SOURCE_ID = 'client.airquality'
// 地名(逆ジオコーディング) client source の決定的 ID (#37)。別ホスト(api.bigdatacloud.net)を使う。
export const GEOCODE_SOURCE_ID = 'client.geocode'
// 地点ナビ client source の決定的 ID (#42)。外部 fetch なし(geolocation + Config.places から純計算)。
export const PLACES_SOURCE_ID = 'client.places'

// 統合 client source の決定的 ID。位置由来の旧 5 source(weather/geoinfo/airquality/geocode/places)を
// 1 source に畳み、内部は 2 group(weather=気象+大気質 / place=地名+標高/TZ+保存地点ナビ)に集約する。
// 旧 5 SOURCE_ID は migration(migrateLocationSourcesMerge)でのみ参照する legacy 定数。
export const LOCATION_SOURCE_ID = 'client.location'
// 統合先の group id。weather group は WEATHER_GROUP_ID(weather.ts)と一致(suncountdown anchors の整合)。
export const LOCATION_WEATHER_GROUP_ID = 'weather'
export const LOCATION_PLACE_GROUP_ID = 'place'

export const DEFAULT_PROFILE_ID = 'default'

// glass layout の「ラベル chip」を表す予約 segId。items の key が `src|grp|@label` のとき、
// その group のラベルテキスト (Claude 等) を glass に出す (自動接頭辞は廃止、配置式)。
export const LABEL_SEG = '@label'

// ユーザー定義の自由テキストラベル。rows には key `@customLabel:<id>` だけを置き、本文は
// glassLayout.customLabels[id].text に持つ (key にテキストを入れない = '|' 衝突回避)。
export const CUSTOM_LABEL_PREFIX = '@customLabel:'
// 行内の左右クラスタ区切り (iOS ステータスバー型)。rows[i] にこの予約キーを 1 つ置くと
// その前 = 左寄せ / 後 = 右寄せ。無ければ全て左寄せ (従来挙動・後方互換)。実機は
// justify-between (pretext で px 計測し中央を space 充填)、companion は flex space-between。
// segKey ('|' 区切り) とも customLabelKey ('@customLabel:' 前置) とも衝突しない。
export const RIGHT_DIVIDER = '@right'
// builtin の表示ラベルはコード所有 (localStorage に保存しない)。companion はこれで
// group/segment の行名を出し、永続化された source label (旧: '本体(時刻/電池)') へ
// フォールバックしない。glass は builtins.ts の短縮ラベルを使う。
export const BUILTIN_GROUP_LABELS: Record<string, string> = {
  clock: 'Clock',
  g2: 'G2', // segment 'Bat' と重複しないよう短縮 ("G2 Bat 82%")
}
export const BUILTIN_SEG_LABELS: Record<string, string> = {
  time: 'Time',
  date: 'Date',
  datetime: 'Date & Time',
  level: 'Battery level',
  rate: 'Rate',
  eta: 'Estimated time left',
}
export const DEFAULT_PLACE_RADIUS_M = 150 // ジオフェンス既定半径(m, #43)
