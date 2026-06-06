// display-identity の単体テスト (表示モデル Phase2)。実行: bun test src/display-identity.test.ts
import { expect, test } from 'bun:test'
import type { Config, GroupRef, ProfileView, SourceDef } from './config'
import {
  collisionCategories,
  computeGroupMergeUnits,
  effectiveGroupHeading,
  effectiveOwner,
  normalizeHeading,
  resolveDisplayLabels,
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

// makeConfig の groups に lastLabel / displayName を後付けする (merge unit テスト用)。
function setGroupMeta(
  cfg: Config,
  sourceId: string,
  groupId: string,
  meta: { lastLabel?: string; displayName?: string },
): void {
  Object.assign(cfg.groups[sourceId]?.[groupId] ?? {}, meta)
}

// groupOrder だけ持つ最小 ProfileView。
function viewOf(order: GroupRef[]): ProfileView {
  return { groups: {}, groupOrder: order } as unknown as ProfileView
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

test('effectiveGroupHeading: displayName > builtin コード所有 > lastLabel の順で解決', () => {
  const cfg = makeConfig([{ id: 'builtin.local' }, { id: 'server.local', label: 'Local' }], {
    'builtin.local': { g2: [{ id: 'level' }] },
    'server.local': { 'claude-code': [{ id: 'cost' }], system: [{ id: 'cpu' }] },
  })
  setGroupMeta(cfg, 'server.local', 'claude-code', { lastLabel: 'Claude' })
  setGroupMeta(cfg, 'server.local', 'system', { lastLabel: 'System', displayName: 'Box' })
  expect(effectiveGroupHeading(cfg, 'server.local', 'claude-code')).toBe('Claude') // lastLabel
  expect(effectiveGroupHeading(cfg, 'server.local', 'system')).toBe('Box') // ユーザー rename 優先
  expect(effectiveGroupHeading(cfg, 'builtin.local', 'g2')).toBe('G2') // builtin はコード所有
  // lastLabel 未捕捉 (一度も online になっていない) は空 = マージ対象外
  expect(effectiveGroupHeading(cfg, 'server.local', 'nope')).toBe('')
})

test('normalizeHeading: NFC + trim で正規化し case は区別する', () => {
  expect(normalizeHeading(' Claude ')).toBe('Claude')
  expect(normalizeHeading('Çafé')).toBe('Çafé') // 結合文字 → NFC 合成
  expect(normalizeHeading('claude')).not.toBe(normalizeHeading('Claude'))
})

test('computeGroupMergeUnits: 同 source の同見出し group を 1 unit に畳む (代表=order 先頭)', () => {
  const cfg = makeConfig([{ id: 'server.local', label: 'Local' }], {
    'server.local': {
      'claude-code': [{ id: 'cost' }],
      'claude-limits': [{ id: 'session' }],
      system: [{ id: 'cpu' }],
    },
  })
  setGroupMeta(cfg, 'server.local', 'claude-code', { lastLabel: 'Claude' })
  setGroupMeta(cfg, 'server.local', 'claude-limits', { lastLabel: ' Claude ' }) // trim 後一致
  setGroupMeta(cfg, 'server.local', 'system', { lastLabel: 'System' })
  const units = computeGroupMergeUnits(
    cfg,
    viewOf([
      { sourceId: 'server.local', groupId: 'claude-code' },
      { sourceId: 'server.local', groupId: 'system' },
      { sourceId: 'server.local', groupId: 'claude-limits' },
    ]),
  )
  expect(units.length).toBe(2)
  expect(units[0]?.heading).toBe('Claude')
  expect(units[0]?.rep).toEqual({ sourceId: 'server.local', groupId: 'claude-code' })
  // member は groupOrder 順 (order 上 system を挟んでも unit は代表位置に畳まれる)
  expect(units[0]?.members.map((r) => r.groupId)).toEqual(['claude-code', 'claude-limits'])
  expect(units[1]?.heading).toBe('System')
})

test('computeGroupMergeUnits: cross-source / 空見出しはマージしない', () => {
  const cfg = makeConfig(
    [
      { id: 'server.a', label: 'A' },
      { id: 'server.b', label: 'B' },
    ],
    {
      'server.a': { claude: [{ id: 'x' }], noname: [{ id: 'y' }] },
      'server.b': { claude: [{ id: 'x' }], anon: [{ id: 'z' }] },
    },
  )
  setGroupMeta(cfg, 'server.a', 'claude', { lastLabel: 'Claude' })
  setGroupMeta(cfg, 'server.b', 'claude', { lastLabel: 'Claude' })
  // noname/anon は lastLabel 無し (空見出し)
  const units = computeGroupMergeUnits(
    cfg,
    viewOf([
      { sourceId: 'server.a', groupId: 'claude' },
      { sourceId: 'server.b', groupId: 'claude' }, // 別マシンの Claude → 別 unit
      { sourceId: 'server.a', groupId: 'noname' },
      { sourceId: 'server.b', groupId: 'anon' }, // 空見出し同士 → それぞれ単独
    ]),
  )
  expect(units.length).toBe(4)
  expect(units.every((u) => u.members.length === 1)).toBe(true)
})

test('computeGroupMergeUnits: 別名 rename で解除・同名 rename で意図的マージ', () => {
  const cfg = makeConfig([{ id: 'server.local', label: 'Local' }], {
    'server.local': {
      'claude-code': [{ id: 'cost' }],
      'claude-limits': [{ id: 'session' }],
      system: [{ id: 'cpu' }],
    },
  })
  setGroupMeta(cfg, 'server.local', 'claude-code', { lastLabel: 'Claude' })
  setGroupMeta(cfg, 'server.local', 'claude-limits', { lastLabel: 'Claude', displayName: 'Quota' })
  setGroupMeta(cfg, 'server.local', 'system', { lastLabel: 'System', displayName: 'Claude' })
  const units = computeGroupMergeUnits(
    cfg,
    viewOf([
      { sourceId: 'server.local', groupId: 'claude-code' },
      { sourceId: 'server.local', groupId: 'claude-limits' },
      { sourceId: 'server.local', groupId: 'system' },
    ]),
  )
  // claude-limits は 'Quota' へ rename = 解除 / system は 'Claude' へ rename = claude-code とマージ
  expect(units.length).toBe(2)
  expect(units[0]?.members.map((r) => r.groupId)).toEqual(['claude-code', 'system'])
  expect(units[1]?.heading).toBe('Quota')
})
