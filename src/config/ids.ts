import { CUSTOM_LABEL_PREFIX, RIGHT_DIVIDER } from './constants'
import type { SourceDef } from './types'

export function customLabelKey(id: string): string {
  return CUSTOM_LABEL_PREFIX + id
}
export function isCustomLabelKey(key: string): boolean {
  return key.startsWith(CUSTOM_LABEL_PREFIX)
}
export function customLabelId(key: string): string {
  return key.slice(CUSTOM_LABEL_PREFIX.length)
}
export function genLabelId(): string {
  return `cl_${genSourceId().slice(0, 8)}`
}

// 意図的マルチページの安定 page id (複製/並べ替え/インジケータ用)。backfill 既定は 'page-1'。
export function genPageId(): string {
  return `page_${genSourceId().slice(0, 8)}`
}
export function isRightDivider(key: string): boolean {
  return key === RIGHT_DIVIDER
}
export function genSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function genProfileId(): string {
  return `prof_${genSourceId().slice(0, 8)}`
}

// machineId 派生の source id。hostname ベースの安定 ID を id 名前空間へ正規化する
// (英数とハイフンのみ・小文字)。これにより削除→同一マシン再追加で同じ id に収束する。
export function deriveSourceId(machineId: string): string {
  const norm = machineId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return norm ? `host-${norm}` : ''
}

// 衝突時 (同一 hostname の別マシン等) の disambiguation。machineId 派生 id に url の
// 短縮 hash を足して別ソース化する。url が無ければ短いランダム接尾辞で代替する。
function urlHash(url: string): string {
  let h = 2166136261 >>> 0 // FNV-1a 32bit
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36).slice(0, 6)
}
export function disambiguateSourceId(base: string, url?: string): string {
  const suffix = url ? urlHash(url) : genSourceId().slice(0, 6)
  return `${base}-${suffix}`
}

// group の default-label 既定値: builtin clock のみ OFF (時刻に 'Clock' は不要)、他は ON。
export function defaultShowGroupLabel(groupId: string): boolean {
  return groupId !== 'clock'
}
export function sourceUrl(s: SourceDef): string | undefined {
  return s.urls?.[0] ?? s.url
}

// source の全経路 (到達順)。urls を正とし、後方互換 url が漏れていれば末尾に補う。
// store の failover fetch はこの順に試す (先頭優先・失敗で次)。
export function sourceUrls(s: SourceDef): string[] {
  const list = Array.isArray(s.urls) ? [...s.urls] : []
  if (s.url && !list.includes(s.url)) list.push(s.url)
  return list
}

// 経路リストを正規化して書き戻す (URL 管理 UI 用)。dedupe し urls を正とし、
// legacy url を先頭に同期する (url を残すと sourceUrls() が削除済み経路を再追加してしまう)。
export function setSourceUrls(s: SourceDef, urls: string[]): void {
  const deduped: string[] = []
  for (const u of urls) if (u && !deduped.includes(u)) deduped.push(u)
  s.urls = deduped
  s.url = deduped[0] // 空なら undefined。legacy url は常に先頭経路に一致させる
}

// 経路を 1 つ削除する。legacy url を畳んだ正リストから除き、stale な再出現を防ぐ。
export function removeSourceUrl(s: SourceDef, url: string): void {
  setSourceUrls(
    s,
    sourceUrls(s).filter((u) => u !== url),
  )
}

// 経路を主経路 (先頭 = 到達順の最優先) に昇格する。存在しなければ no-op。
export function promoteSourceUrl(s: SourceDef, url: string): void {
  const all = sourceUrls(s)
  if (!all.includes(url)) return
  setSourceUrls(s, [url, ...all.filter((u) => u !== url)])
}
export function genPlaceId(): string {
  return `pl_${genSourceId().slice(0, 8)}`
}
