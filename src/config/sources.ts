import { BUILTIN_SOURCE_ID, LOCAL_SOURCE_ID } from './constants'
import { deriveSourceId, disambiguateSourceId, genSourceId } from './ids'
import { pruneRemovedViews } from './normalize'
import { activeProfile } from './profiles'
import { mapViewRows, type RowSet, viewRowSets } from './rows'
import type { Config, GlassLayout, Profile, RemovedSourceView, SourceDef, ViewGroup } from './types'

// 新規 server ソースを不変 ID で追加する (ユーザー追加。ランダム ID)。
// 素材 groups と active profile の enabledSourceIds + view 枠を確保する。
export function addServer(cfg: Config, label: string, url?: string): SourceDef {
  const def: SourceDef = { id: genSourceId(), kind: 'server', label, urls: url ? [url] : [] }
  if (url) def.url = url
  cfg.sources.push(def)
  cfg.groups[def.id] = {}
  const prof = activeProfile(cfg)
  if (!prof.enabledSourceIds.includes(def.id)) prof.enabledSourceIds.push(def.id)
  prof.view.groups[def.id] ??= {}
  return def
}

// 暗黙の既定サーバ (同一オリジン) を決定的 ID で保証する。server が 1 つも無いときだけ追加する。
// addServer (ランダム ID) と違い固定 ID なので、bridge 準備前後の二重 init や再起動で再追加されても
// 同一ソースに収束し、view が孤立蓄積しない。追加したら true。
export function ensureDefaultServer(cfg: Config, url: string): boolean {
  if (cfg.sources.some((s) => s.kind === 'server')) return false
  cfg.sources.push({ id: LOCAL_SOURCE_ID, kind: 'server', label: 'Local', url, urls: [url] })
  cfg.groups[LOCAL_SOURCE_ID] ??= {}
  const prof = activeProfile(cfg)
  if (!prof.enabledSourceIds.includes(LOCAL_SOURCE_ID)) prof.enabledSourceIds.push(LOCAL_SOURCE_ID)
  prof.view.groups[LOCAL_SOURCE_ID] ??= {}
  return true
}

// ソースを削除する (builtin は不可)。素材 groups と全 profile の view + enabledSourceIds も掃除する。
// machineId を持つ source は削除前に表示レシピを tombstone (recentlyRemoved) へ退避し、
// 同一マシン再追加 (machineId 一致) で可視性/並び/glassLayout が復活する経路を残す。
export function removeSource(cfg: Config, id: string): void {
  if (id === BUILTIN_SOURCE_ID) return
  const removed = cfg.sources.find((s) => s.id === id)
  if (removed?.machineId) captureRemovedView(cfg, removed)
  discardSource(cfg, id)
}

// source と全 profile view 参照を物理削除する (tombstone を書かない内部 helper)。
// glassLayout / 各 page (layout + grid) からも当該 source の segKey を除去する
// (削除後に幽霊 chip を残さない。配置の復元は tombstone 経由で行う)。
function discardSource(cfg: Config, id: string): void {
  if (id === BUILTIN_SOURCE_ID) return
  cfg.sources = cfg.sources.filter((s) => s.id !== id)
  delete cfg.groups[id]
  for (const p of cfg.profiles) {
    p.enabledSourceIds = p.enabledSourceIds.filter((sid) => sid !== id)
    delete p.view.groups[id]
    p.view.groupOrder = p.view.groupOrder.filter((r) => r.sourceId !== id)
    mapViewRows(p.view, (row) => row.filter((k) => k.split('|')[0] !== id))
  }
}

// 削除する source の表示レシピを全 profile から集めて tombstone に退避する (machineId キー)。
// view を一切持たない (どの profile にも配置されていない) なら退避しない。
function captureRemovedView(cfg: Config, src: SourceDef): void {
  const machineId = src.machineId
  if (!machineId) return
  const profiles: Record<string, RemovedSourceView> = {}
  for (const p of cfg.profiles) {
    const groups = p.view.groups[src.id]
    const groupRefs = p.view.groupOrder.filter((r) => r.sourceId === src.id).map((r) => r.groupId)
    const glassRows = collectGlassRows(p.view.glassLayout, src.id)
    const enabled = p.enabledSourceIds.includes(src.id)
    if (!groups && !groupRefs.length && !glassRows && !enabled) continue
    profiles[p.id] = {
      enabled,
      groups: groups ? structuredCloneGroups(groups) : {},
      groupRefs,
      glassRows,
    }
  }
  if (!Object.keys(profiles).length) return
  cfg.recentlyRemoved ??= {}
  cfg.recentlyRemoved[machineId] = { at: Date.now(), oldSourceId: src.id, profiles }
  pruneRemovedViews(cfg)
}

// glassLayout.rows のうち当該 source の segKey を含む行だけを profileId 用に抜き出す。
// 行 index を保ってオブジェクト化し、復元時に元の行へ戻す (他 source の chip には触れない)。
function collectGlassRows(
  lay: GlassLayout | undefined,
  sourceId: string,
): Record<string, string[][]> | null {
  if (!lay) return null
  const out: Record<string, string[][]> = {}
  lay.rows.forEach((row, i) => {
    const own = row.filter((k) => k.split('|')[0] === sourceId)
    if (own.length) out[String(i)] = [own]
  })
  return Object.keys(out).length ? out : null
}

function structuredCloneGroups(g: Record<string, ViewGroup>): Record<string, ViewGroup> {
  const out: Record<string, ViewGroup> = {}
  for (const [gid, vg] of Object.entries(g)) out[gid] = { ...vg, segments: { ...vg.segments } }
  return out
}

// source の id を newId へ付け替え、素材 groups と全 profile の view 参照
// (groups / groupOrder / glassLayout.rows / enabledSourceIds) を旧 id から新 id へ remap する。
// 既存 randomUUID source が machineId を後付けで採用するときに過去の profile 参照を壊さないための要。
// newId が既に使われていれば何もしない (呼び出し側が衝突解決済みである前提)。
function reKeySource(cfg: Config, oldId: string, newId: string): void {
  if (oldId === newId) return
  if (cfg.sources.some((s) => s.id === newId)) return
  const src = cfg.sources.find((s) => s.id === oldId)
  if (!src) return
  src.id = newId
  if (cfg.groups[oldId]) {
    cfg.groups[newId] = cfg.groups[oldId]
    delete cfg.groups[oldId]
  }
  for (const p of cfg.profiles) {
    p.enabledSourceIds = p.enabledSourceIds.map((sid) => (sid === oldId ? newId : sid))
    if (p.view.groups[oldId]) {
      p.view.groups[newId] = p.view.groups[oldId]
      delete p.view.groups[oldId]
    }
    for (const r of p.view.groupOrder) if (r.sourceId === oldId) r.sourceId = newId
    // glassLayout / 各 page (layout + grid) の segKey も新 id へ付け替える (配置を保つ)。
    mapViewRows(p.view, (row) => row.map((k) => reKeySegKey(k, oldId, newId)))
  }
}

// segKey (sourceId|groupId|segId) の先頭 sourceId を付け替える。custom ラベル / @right 等は素通し。
function reKeySegKey(key: string, oldId: string, newId: string): string {
  const parts = key.split('|')
  if (parts.length < 2 || parts[0] !== oldId) return key
  parts[0] = newId
  return parts.join('|')
}

// enabledSourceIds: fromId が有効なら toId も有効化する (fetch 範囲を維持)。
function mergeEnabledSourceIds(p: Profile, fromId: string, toId: string): void {
  if (p.enabledSourceIds.includes(fromId) && !p.enabledSourceIds.includes(toId)) {
    p.enabledSourceIds.push(toId)
  }
}

// view.groups: toId に無い groupId だけ fromId から移送する (clone)。既存は toId 側を優先。
function mergeViewGroups(p: Profile, fromId: string, toId: string): void {
  const fromGroups = p.view.groups[fromId]
  if (!fromGroups) return
  p.view.groups[toId] ??= {}
  for (const [gid, vg] of Object.entries(fromGroups)) {
    p.view.groups[toId][gid] ??= { ...vg, segments: { ...vg.segments } }
  }
}

// groupOrder: toId に未登録の groupId だけ fromId から末尾へ追加する (順序維持)。
function mergeGroupOrder(p: Profile, fromId: string, toId: string): void {
  const present = new Set(
    p.view.groupOrder.filter((r) => r.sourceId === toId).map((r) => r.groupId),
  )
  for (const r of p.view.groupOrder) {
    if (r.sourceId === fromId && !present.has(r.groupId)) {
      p.view.groupOrder.push({ sourceId: toId, groupId: r.groupId })
      present.add(r.groupId)
    }
  }
}

// fromId の view 断片を toId へ統合する (同一マシンへの合流時。reKeySource と違い toId が
// 既存なので additive にマージし、toId の現状を優先する = ユーザーの現配置を壊さない)。
// 統合後も fromId 参照が残るが、呼び出し側の discardSource が物理削除する。
function mergeSourceViewInto(cfg: Config, fromId: string, toId: string): void {
  if (fromId === toId) return
  for (const p of cfg.profiles) {
    mergeEnabledSourceIds(p, fromId, toId)
    mergeViewGroups(p, fromId, toId)
    mergeGroupOrder(p, fromId, toId)
    // 行集合 (glassLayout / 各 page.layout / 各 page.grid) ごとに remap する。
    // dedup の状態 (present) は集合内で共有し、集合間では共有しない (grid とその凍結
    // layout は別の表示面なので、片方に在る chip がもう片方の remap を妨げない)。
    for (const rs of viewRowSets(p.view)) mergeRowSet(rs, fromId, toId)
  }
}

// 行集合の fromId chip を toId へ remap する。重複は exact segKey 単位で排除する
// (同一 chip が rows に二重に乗ると同じ表示が 2 回出るため)。既に toId chip が在る位置を尊重し、
// 衝突しない fromId chip は配置を保ったまま remap する (additive)。
function mergeRowSet(rs: RowSet, fromId: string, toId: string): void {
  const rows = rs.read()
  // 既に rows 内に存在する toId segKey 集合 (これと衝突する fromId chip は捨てる)。
  const present = new Set<string>()
  for (const row of rows) {
    for (const k of row) {
      if (k.split('|')[0] === toId) present.add(k)
    }
  }
  rs.write(
    rows.map((row) =>
      row.flatMap((k) => {
        if (k.split('|')[0] !== fromId) return [k]
        const remapped = reKeySegKey(k, fromId, toId)
        if (present.has(remapped)) return [] // 同一 chip が既配置なら捨てる (重複防止)
        present.add(remapped)
        return [remapped]
      }),
    ),
  )
}

// 接続テスト成功後、編集中 source に machineId を反映して id を安定化する。返り値は確定した SourceDef。
//  1. 既に同 machineId の別 source があれば → url を urls に足すだけで合流し、編集 source は削除して合流先を返す。
//  2. machineId 派生 id が空 (フォールバック) → 既存挙動 (randomUUID 維持) で machineId だけ後付け。
//  3. それ以外 → 編集 source の id を machineId 派生 id へ reKey (衝突時は url hash で disambiguate)。
//     さらに tombstone (同 machineId) があれば profile の view を復元する。
export function reconcileSourceMachine(
  cfg: Config,
  editingId: string,
  machineId: string,
  url: string,
): SourceDef | null {
  const editing = cfg.sources.find((s) => s.id === editingId)
  if (!editing) return null

  // machineId は同一マシン判定 (合流・id 安定化) の唯一のキー。空/空白のみは identity に
  // 使えない (空同士・undefined 同士が一致して別マシンを 1 source に潰す誤合流 = データ破壊)。
  // その場合は machineId を一切代入せず、合流も id 安定化もせず editing をそのまま返す
  // (randomUUID を維持し、別マシンとの混線を構造的に排除する)。
  const mid = machineId.trim()
  if (!mid) return editing
  editing.machineId = mid

  // (1) 同 machineId の既存 source があれば url を足して合流する。編集中 source は
  //     物理削除するが、その前に全 profile の view 断片 (可視性/並び/glass 配置/enabled) を
  //     合流先 id へ統合する。編集中 source は設定済み source を edit-source で開いた実体で
  //     あり得る (placeholder とは限らない) ため、view を捨てると同一マシンなのに配置が消える。
  //     合流先の現配置を優先する additive 統合なので tombstone は不要。
  //     合流条件は s.machineId を truthy ガードする (空 machineId 同士の一致を防ぐ)。
  const merged = cfg.sources.find((s) => s.id !== editingId && !!s.machineId && s.machineId === mid)
  if (merged) {
    if (!merged.urls.includes(url)) merged.urls.push(url)
    merged.url ??= url
    mergeSourceViewInto(cfg, editingId, merged.id)
    discardSource(cfg, editingId)
    return merged
  }

  const base = deriveSourceId(mid)
  // (2) フォールバック: machineId が id 化できない (記号のみ等で deriveSourceId が '' を返す)
  //     → 既存 id を維持 (machineId のみ alias で付与済み)。合流もキー化もしない。
  if (!base) return editing

  // (3) 衝突回避: base が editing 以外で既に使われていれば url hash で別 id にする。
  const taken = cfg.sources.some((s) => s.id !== editingId && s.id === base)
  const newId = taken ? disambiguateSourceId(base, url) : base
  reKeySource(cfg, editingId, newId)
  restoreRemovedView(cfg, mid, newId)
  return cfg.sources.find((s) => s.id === newId) ?? editing
}

// tombstone (machineId 一致) があれば各 profile の view を復元する。素材 (cfg.groups) は
// status sync が再構築するので、ここでは可視性/並び/glassLayout/enabled だけ戻す。
// 既存 view を上書きしない (additive): 既に配置済みの group/order/行はユーザーの現状を優先する。
function restoreRemovedView(cfg: Config, machineId: string, newId: string): void {
  const tomb = cfg.recentlyRemoved?.[machineId]
  if (!tomb) return
  for (const p of cfg.profiles) {
    const snap = tomb.profiles[p.id]
    if (!snap) continue
    if (snap.enabled && !p.enabledSourceIds.includes(newId)) p.enabledSourceIds.push(newId)
    p.view.groups[newId] ??= {}
    for (const [gid, vg] of Object.entries(snap.groups)) {
      p.view.groups[newId][gid] ??= { ...vg, segments: { ...vg.segments } }
    }
    const present = new Set(
      p.view.groupOrder.filter((r) => r.sourceId === newId).map((r) => r.groupId),
    )
    for (const gid of snap.groupRefs) {
      if (!present.has(gid)) p.view.groupOrder.push({ sourceId: newId, groupId: gid })
    }
    restoreGlassRows(p, snap, tomb.oldSourceId, newId)
  }
  delete cfg.recentlyRemoved?.[machineId]
}

// tombstone の glass 行を現在の glassLayout へ戻す (旧 sourceId|... を newId|... へ remap)。
// 当該行に既に同 source の chip があれば上書きしない (ユーザーの現配置を尊重)。
function restoreGlassRows(
  p: Profile,
  snap: RemovedSourceView,
  oldSourceId: string,
  newId: string,
): void {
  const lay = p.view.glassLayout
  if (!lay || !snap.glassRows) return
  for (const [idxStr, rows] of Object.entries(snap.glassRows)) {
    const i = Number(idxStr)
    if (!Number.isInteger(i) || i < 0 || i >= lay.rows.length) continue
    const keys = (rows[0] ?? []).map((k) => reKeySegKey(k, oldSourceId, newId))
    const row = lay.rows[i] ?? []
    if (row.some((k) => k.split('|')[0] === newId)) continue // 既配置は尊重
    lay.rows[i] = [...row, ...keys]
  }
}
