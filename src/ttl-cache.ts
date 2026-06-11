// client source 共通: 位置ベース TTL cache(localStorage)。weather/airquality/geocode/geoinfo の
// 4 provider が同一の「lat/lon/fetchedAt + payload を JSON で読み書きし、型ガード後に採用、fresh/stale
// を fetchedAt の経過で判定する」パターンを重複させていたため、ここへ集約する(#85 Phase 1)。
//
// payload の型(reading か StatusDoc か)・cache key・fresh/stale の長さは provider ごとに異なるため、
// それらは呼び出し側が与える。optSig は #40(weather の単位/フォーマット opt)向けで、geocode/geoinfo は
// 渡さなければ無視される(常に一致扱い)。

// 永続される cache のレコード形。optSig は単位/フォーマット opt が変わったら fresh でも無効化するための
// 任意の識別子文字列(weather 用、PR B で使用)。
export type GeoCacheEntry<T> = {
  lat: number
  lon: number
  fetchedAt: number
  optSig?: string
  payload: T
}

// localStorage から cache を読む。壊れた JSON / 型不一致は null(provider 側は cache 無し扱いにする)。
// parsePayload は payload 部分だけを検証/正規化する型ガード(provider ごとの reading/StatusDoc 形)。
export function readGeoCache<T>(
  cacheKey: string,
  parsePayload: (raw: unknown) => T | null,
): GeoCacheEntry<T> | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(cacheKey)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<GeoCacheEntry<unknown>>
    if (typeof c.lat !== 'number' || typeof c.lon !== 'number' || typeof c.fetchedAt !== 'number') {
      return null
    }
    const payload = parsePayload(c.payload)
    if (payload === null) return null
    return {
      lat: c.lat,
      lon: c.lon,
      fetchedAt: c.fetchedAt,
      optSig: typeof c.optSig === 'string' ? c.optSig : undefined,
      payload,
    }
  } catch {
    return null
  }
}

// localStorage へ cache を書く。quota 等の例外は無視(best-effort)。
export function writeGeoCache<T>(cacheKey: string, entry: GeoCacheEntry<T>): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(cacheKey, JSON.stringify(entry))
  } catch {
    // quota 等は無視(best-effort)
  }
}

// cache が fresh(再取得不要)か。optSig を渡した場合は一致も必須(#40: option 変更時は fresh でも再取得)。
// optSig を渡さなければ optSig は比較しない(geocode/geoinfo はオプション非依存)。
export function isCacheFresh<T>(
  cache: GeoCacheEntry<T> | null,
  now: number,
  freshMs: number,
  optSig?: string,
): cache is GeoCacheEntry<T> {
  if (!cache) return false
  if (optSig !== undefined && cache.optSig !== optSig) return false
  return now - cache.fetchedAt < freshMs
}

// 失敗時に cache を stale 表示してよい範囲か(fetchedAt から staleMaxMs 未満)。
export function isCacheStaleOk<T>(
  cache: GeoCacheEntry<T> | null,
  now: number,
  staleMaxMs: number,
): cache is GeoCacheEntry<T> {
  return !!cache && now - cache.fetchedAt < staleMaxMs
}
