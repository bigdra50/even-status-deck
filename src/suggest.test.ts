// suggestProfileByGeofence(#43)の純粋ロジック。実行: bun test src/suggest.test.ts
import { expect, test } from 'bun:test'
import { addPlace, addProfile, emptyConfig, setProfileGeofence } from './config'
import { suggestProfileByGeofence } from './suggest'

function cfgWithBinding(mode: 'suggest' | 'auto') {
  const cfg = emptyConfig()
  const home = addPlace(cfg, 'Home', 35, 139)
  const prof = addProfile(cfg, 'Home preset') // addProfile は active にするので Default へ戻す
  cfg.activeProfileId = 'default'
  setProfileGeofence(cfg, prof.id, home.id, mode)
  return { cfg, home, prof }
}

test('suggestProfileByGeofence: suggest モードで圏内なら提案', () => {
  const { cfg, home, prof } = cfgWithBinding('suggest')
  const s = suggestProfileByGeofence(cfg, home.id)
  expect(s?.profileId).toBe(prof.id)
  expect(s?.reason).toBe('geofence')
  expect(s?.placeName).toBe('Home')
})

test('suggestProfileByGeofence: auto モードは提案しない(自動切替に任せる)', () => {
  const { cfg, home } = cfgWithBinding('auto')
  expect(suggestProfileByGeofence(cfg, home.id)).toBeNull()
})

test('suggestProfileByGeofence: 圏外/未バインド/active 自身は提案しない', () => {
  const { cfg, prof } = cfgWithBinding('suggest')
  expect(suggestProfileByGeofence(cfg, null)).toBeNull() // 圏外
  expect(suggestProfileByGeofence(cfg, 'other')).toBeNull() // 別 place
  // bound preset が active なら提案しない
  cfg.activeProfileId = prof.id
  expect(suggestProfileByGeofence(cfg, cfg.places?.[0].id ?? '')).toBeNull()
})
