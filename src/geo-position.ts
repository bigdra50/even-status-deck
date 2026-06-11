// client source 共通: 現在地の取得(geolocation)+ 座標丸め。weather/airquality/geocode/geoinfo の
// 4 provider が同一の geolocation 呼び出し(GEO_TIMEOUT_MS/GEO_MAX_AGE_MS)と round2(PII 抑制)を
// 重複させていたため、ここへ集約する(#85 Phase 1)。

// OS の geolocation 許可ダイアログ/取得タイムアウト。実機で許可待ちが長引いても source を固まらせない。
const GEO_TIMEOUT_MS = 10_000
// OS の位置キャッシュ許容(初回以外は許可ダイアログを出さない)。
const GEO_MAX_AGE_MS = 30 * 60_000

// 座標を小数 2 桁(約 1.1km)に丸める。PII 抑制のため、cache key/外部 API へはこの丸め値のみ渡す。
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// 現在地を 1 回取得する(コールバック API を Promise 化)。初回のみ OS 許可ダイアログが出る。
function getPosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('geolocation unavailable'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(`geolocation error ${e.code}: ${e.message}`)),
      { enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: GEO_MAX_AGE_MS },
    )
  })
}

// 丸め済み現在地を 1 回取得する(getPosition + round2 の組)。座標は呼び出し側で cache key/URL に使う。
export async function getRoundedPosition(): Promise<{ lat: number; lon: number }> {
  const pos = await getPosition()
  return { lat: round2(pos.lat), lon: round2(pos.lon) }
}
