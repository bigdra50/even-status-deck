import { defaultImuConfig } from '../imu'
import { defaultCategory } from '../taxonomy'
import {
  BUILTIN_SOURCE_ID,
  CONFIG_VERSION,
  DEFAULT_PROFILE_ID,
  LOCATION_SOURCE_ID,
} from './constants'
import { defaultShowGroupLabel } from './ids'
import { normalizePlaces } from './places'
import { activeView, emptyDefaultProfile } from './profiles'
import type { Config, GroupRef } from './types'

// builtin local ソース (時刻/電池) を必ず先頭に持たせる。label はコード所有なので
// 既存エントリにも毎回上書きし、永続化された旧ラベル ('本体(時刻/電池)' 等) を消す。
export function ensureBuiltin(cfg: Config): void {
  const existing = cfg.sources.find((s) => s.id === BUILTIN_SOURCE_ID)
  if (existing) {
    existing.kind = 'builtin'
    existing.label = 'Device' // SOURCES には出さない (companion 側で builtin を除外)。内部表示用
    existing.urls ??= []
    existing.displayOwner = 'Glass' // 主要衝突源 (g2 電池 vs PC 電池) の出自。コード所有
    existing.origin = 'app_bundled' // 同梱 source (Home の Included セクション)
  } else {
    cfg.sources.unshift({
      id: BUILTIN_SOURCE_ID,
      kind: 'builtin',
      label: 'Device',
      urls: [],
      displayOwner: 'Glass',
      origin: 'app_bundled',
    })
  }
  if (!cfg.groups[BUILTIN_SOURCE_ID]) cfg.groups[BUILTIN_SOURCE_ID] = {}
  // builtin は全 profile の enabledSourceIds に必ず含める (fetch 範囲に builtin を残す)。
  for (const p of cfg.profiles) {
    if (!p.enabledSourceIds.includes(BUILTIN_SOURCE_ID))
      p.enabledSourceIds.unshift(BUILTIN_SOURCE_ID)
  }
  migrateBuiltinGroups(cfg)
  ensureBuiltinSegments(cfg)
}

// 統合 client source "Location" (現在地ベース)。SDK に GPS が無いため位置は companion WebView の
// geolocation で取得する。既定は無効 (opt-in): enabledSourceIds に入れず、ユーザーが "Add source" で
// 有効化したとき初めて位置許可を求める。素材 group(weather/place)は status sync が補充する。
// 旧 5 source(weather/geoinfo/airquality/geocode/places)は migrateLocationSourcesMerge で本 source へ畳む。
export function ensureClientLocation(cfg: Config): void {
  const existing = cfg.sources.find((s) => s.id === LOCATION_SOURCE_ID)
  if (existing) {
    existing.kind = 'client'
    existing.label = 'Location'
    existing.urls ??= []
    existing.origin = 'app_bundled'
  } else {
    cfg.sources.push({
      id: LOCATION_SOURCE_ID,
      kind: 'client',
      label: 'Location',
      urls: [],
      origin: 'app_bundled',
    })
  }
  cfg.groups[LOCATION_SOURCE_ID] ??= {}
  cfg.places ??= []
}

// 旧 builtin group 'hud' (時刻/電池を 1 group に詰めていた) を clock/g2 へ再構成する。
// segment は id が変わる (g2→level, drain→rate, est→eta) ため旧トグルは引き継がず、
// sync が status から既定 ON で補充する。builtin の表示順 (先頭) は維持する。
function migrateBuiltinGroups(cfg: Config): void {
  const bg = cfg.groups[BUILTIN_SOURCE_ID]
  if (!bg?.hud) return
  delete bg.hud
  if (!bg.clock) bg.clock = { segments: [] }
  if (!bg.g2) bg.g2 = { segments: [] }
  const view = activeView(cfg)
  view.groups[BUILTIN_SOURCE_ID] ??= {}
  view.groups[BUILTIN_SOURCE_ID].clock ??= { enabled: true, showDefaultLabel: false, segments: {} }
  view.groups[BUILTIN_SOURCE_ID].g2 ??= { enabled: true, showDefaultLabel: true, segments: {} }
  const idx = view.groupOrder.findIndex((r) => r.sourceId === BUILTIN_SOURCE_ID)
  view.groupOrder = view.groupOrder.filter((r) => r.sourceId !== BUILTIN_SOURCE_ID)
  const refs: GroupRef[] = [
    { sourceId: BUILTIN_SOURCE_ID, groupId: 'clock' },
    { sourceId: BUILTIN_SOURCE_ID, groupId: 'g2' },
  ]
  if (idx >= 0) view.groupOrder.splice(idx, 0, ...refs)
  else view.groupOrder.unshift(...refs)
}

// builtin (clock/g2) は code 所有の固定 capability。data 駆動の sync を待たず素材メタへ静的 seed する。
// これにより companion Items が放電データ未蓄積でも rate/eta を発見・トグル・配置・条件設定でき、
// glass は live status に存在する segment だけを描く責務分離を保つ (StatusDoc は実データのみ)。
// idempotent: 既存 segment/順序は温存し、不足分のみ canonical 順で補う。category は sync と同じ
// defaultCategory で seed (g2|level=battery / g2|rate=power_rate / g2|eta=duration)。
const BUILTIN_SEG_SEED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['clock', ['datetime']],
  ['g2', ['level', 'rate', 'eta']],
]
function ensureBuiltinSegments(cfg: Config): void {
  const groups = cfg.groups[BUILTIN_SOURCE_ID]
  if (!groups) return
  const view = activeView(cfg)
  view.groups[BUILTIN_SOURCE_ID] ??= {}
  const vgroups = view.groups[BUILTIN_SOURCE_ID]
  const missing: GroupRef[] = []
  for (const [gid, segIds] of BUILTIN_SEG_SEED) {
    let gm = groups[gid]
    if (!gm) {
      gm = { segments: [] }
      groups[gid] = gm
    }
    for (const sid of segIds) {
      if (!gm.segments.some((s) => s.id === sid)) {
        gm.segments.push({ id: sid, category: defaultCategory(gid, sid) })
      }
    }
    vgroups[gid] ??= { enabled: true, showDefaultLabel: defaultShowGroupLabel(gid), segments: {} }
    if (!view.groupOrder.some((r) => r.sourceId === BUILTIN_SOURCE_ID && r.groupId === gid)) {
      missing.push({ sourceId: BUILTIN_SOURCE_ID, groupId: gid })
    }
  }
  if (missing.length) view.groupOrder.unshift(...missing) // builtin は先頭。clock→g2 の順を維持
}

export function emptyConfig(): Config {
  const c: Config = {
    version: CONFIG_VERSION,
    sources: [],
    groups: {},
    profiles: [emptyDefaultProfile()],
    activeProfileId: DEFAULT_PROFILE_ID,
    imu: defaultImuConfig(),
  }
  ensureBuiltin(c)
  ensureClientLocation(c)
  normalizePlaces(c)
  return c
}
