// display-identity の単体テスト (表示モデル Phase2)。実行: bun test src/display-identity.test.ts
import { expect, test } from 'bun:test'
import type { Config, SourceDef } from './config'
import {
  collisionCategories,
  effectiveOwner,
  resolveDisplayLabels,
  resolveGroupDisplayNames,
} from './display-identity'
import type { StatusDoc } from './status-types'

// テスト用の最小 Config(sources + groups だけ使う)。
function makeConfig(
  sources: Array<Partial<SourceDef> & { id: string }>,
  groups: Record<string, Record<string, Array<{ id: string; category?: string }>>>,
): Config {
  return {
    sources: sources.map((s) => ({ kind: 'server', label: s.id, urls: [], ...s })),
    groups: Object.fromEntries(
      Object.entries(groups).map(([sid, gs]) => [
        sid,
        Object.fromEntries(Object.entries(gs).map(([gid, segs]) => [gid, { segments: segs }])),
      ]),
    ),
  } as unknown as Config
}

test('effectiveOwner: displayOwner 優先、空/未設定は label にフォールバック', () => {
  expect(effectiveOwner({ label: 'Local', displayOwner: 'Mac' } as SourceDef)).toBe('Mac')
  expect(effectiveOwner({ label: 'Local' } as SourceDef)).toBe('Local')
  expect(effectiveOwner({ label: 'Local', displayOwner: '  ' } as SourceDef)).toBe('Local')
})

test('collisionCategories: 同 category を異なる owner が出すと衝突', () => {
  const cfg = makeConfig(
    [
      { id: 'builtin.local', label: 'Device', displayOwner: 'Glass' },
      { id: 'server.local', label: 'Local' },
    ],
    {
      'builtin.local': { g2: [{ id: 'level', category: 'battery' }] },
      'server.local': {
        system: [
          { id: 'battery', category: 'battery' },
          { id: 'cpu', category: 'cpu_percent' },
        ],
        codex: [
          { id: '5h', category: 'usage_percent' },
          { id: 'weekly', category: 'usage_percent' }, // 同 owner 同 category → 衝突しない
        ],
      },
    },
  )
  const collide = collisionCategories(cfg)
  expect(collide.has('battery')).toBe(true) // Glass vs Local
  expect(collide.has('cpu_percent')).toBe(false) // 1 owner のみ
  expect(collide.has('usage_percent')).toBe(false) // 同 owner(Local)が2つ出すだけ
})

test('resolveDisplayLabels: 衝突 segment に owner prefix、非衝突は null、offline は不在', () => {
  const cfg = makeConfig(
    [
      { id: 'builtin.local', label: 'Device', displayOwner: 'Glass' },
      { id: 'server.local', label: 'Mac' },
    ],
    {
      'builtin.local': { g2: [{ id: 'level', category: 'battery' }] },
      'server.local': {
        system: [
          { id: 'battery', category: 'battery' },
          { id: 'cpu', category: 'cpu_percent' },
        ],
      },
    },
  )
  const g2Doc: StatusDoc = {
    version: 1,
    ts: 0,
    groups: [{ id: 'g2', label: '', segments: [{ id: 'level', label: 'Bat', value: '82%' }] }],
  }
  // server.local は offline (status なし) → battery segment は map に出ない(揺らさない)
  const labels = resolveDisplayLabels(cfg, { 'builtin.local': g2Doc, 'server.local': null })
  expect(labels.get('builtin.local|g2|level')).toBe('Glass Bat') // 衝突 + live label
  expect(labels.has('server.local|system|battery')).toBe(false) // offline → 不在
  // cpu は非衝突だが offline なので map に出ない
  expect(labels.has('server.local|system|cpu')).toBe(false)
})

test('resolveDisplayLabels: 両方 online なら双方に owner prefix、非衝突は null クリア', () => {
  const cfg = makeConfig(
    [
      { id: 'builtin.local', label: 'Device', displayOwner: 'Glass' },
      { id: 'server.local', label: 'Mac' },
    ],
    {
      'builtin.local': { g2: [{ id: 'level', category: 'battery' }] },
      'server.local': {
        system: [
          { id: 'battery', category: 'battery' },
          { id: 'cpu', category: 'cpu_percent' },
        ],
      },
    },
  )
  const statuses: Record<string, StatusDoc | null> = {
    'builtin.local': {
      version: 1,
      ts: 0,
      groups: [{ id: 'g2', label: '', segments: [{ id: 'level', label: 'Bat', value: '82%' }] }],
    },
    'server.local': {
      version: 1,
      ts: 0,
      groups: [
        {
          id: 'system',
          label: '',
          segments: [
            { id: 'battery', label: 'Bat', value: '60%' },
            { id: 'cpu', label: 'CPU', value: '12%' },
          ],
        },
      ],
    },
  }
  const labels = resolveDisplayLabels(cfg, statuses)
  expect(labels.get('builtin.local|g2|level')).toBe('Glass Bat')
  expect(labels.get('server.local|system|battery')).toBe('Mac Bat')
  expect(labels.get('server.local|system|cpu')).toBe(null) // 非衝突 → クリア
})

test('resolveGroupDisplayNames: 同 source の同 label group を区別 (代表は素のまま)', () => {
  const cfg = makeConfig([{ id: 'server.local', label: 'Local' }], {
    'server.local': {
      'claude-code': [{ id: 'cost' }],
      'claude-limits': [{ id: 'session' }],
      system: [{ id: 'cpu' }],
    },
  })
  const doc: StatusDoc = {
    version: 1,
    ts: 0,
    groups: [
      {
        id: 'claude-code',
        label: 'Claude',
        segments: [{ id: 'cost', label: 'Cost', value: '$1' }],
      },
      {
        id: 'claude-limits',
        label: 'Claude',
        segments: [{ id: 'session', label: '5h', value: '45%' }],
      },
      { id: 'system', label: 'System', segments: [{ id: 'cpu', label: 'CPU', value: '12%' }] },
    ],
  }
  const m = resolveGroupDisplayNames(cfg, { 'server.local': doc })
  expect(m.get('server.local|claude-code')).toBe(null) // 代表(groupId 昇順先頭) は素のまま
  expect(m.get('server.local|claude-limits')).toBe('Claude (limits)') // suffix で区別
  expect(m.get('server.local|system')).toBe(null) // 非衝突 → クリア
})

test('resolveGroupDisplayNames: offline group は map に含めない(揺らさない)', () => {
  const cfg = makeConfig([{ id: 'server.local', label: 'Local' }], {
    'server.local': { 'claude-code': [{ id: 'cost' }], 'claude-limits': [{ id: 'session' }] },
  })
  // claude-limits は status に無い (offline)
  const doc: StatusDoc = {
    version: 1,
    ts: 0,
    groups: [
      {
        id: 'claude-code',
        label: 'Claude',
        segments: [{ id: 'cost', label: 'Cost', value: '$1' }],
      },
    ],
  }
  const m = resolveGroupDisplayNames(cfg, { 'server.local': doc })
  expect(m.get('server.local|claude-code')).toBe(null) // 衝突相手 offline → 単独 → クリア
  expect(m.has('server.local|claude-limits')).toBe(false) // offline → 不在 (既存値を維持)
})
