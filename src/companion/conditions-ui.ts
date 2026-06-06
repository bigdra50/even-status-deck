// change イベントハンドラ (表示条件 leaf 編集 / 表示オプション / preset 切替 / ページ名) と接続テスト。
// index.ts から切り出した UI 編集レイヤ。依存は state/render-port/sync/rows と外部のみ (一方向)。

import {
  activeView,
  type GroupRef,
  reconcileSourceMachine,
  saveConfig,
  setActiveProfile,
  sourceById,
} from '../config'
import { fetchMachineFrom } from '../data'
import { setSegmentOption, setSourceOption } from '../options'
import { refreshSourceById, setSourcesFromConfig } from '../store'
import type { DisplayUi, VisibilityCond, VisibilityLeaf } from '../visibility'
import { requestRender } from './render-port'
import { segChoicesFor } from './rows'
import { ctx } from './state'
import { applyProfileChange, parseKey } from './sync'

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))
}

type ChangeHandler = (t: HTMLElement, e: Event) => void

type SegVisCtx = {
  ref: GroupRef
  segId: string
  vis: VisibilityCond
  val: string
}

type SegVisLeafCtx = SegVisCtx & { idx: number; leaf: VisibilityLeaf }

function segVisVal(t: HTMLElement): string {
  return (t as HTMLInputElement | HTMLSelectElement).value
}

function resolveSegVis(t: HTMLElement): SegVisCtx | null {
  const key = t.dataset.key
  const segId = t.dataset.seg
  if (!key || !segId) return null
  const ref = parseKey(key)
  const sm = ctx.config.groups[ref.sourceId]?.[ref.groupId]?.segments.find((s) => s.id === segId)
  const vis = sm?.visibility
  if (!vis) return null
  return { ref, segId, vis, val: segVisVal(t) }
}

function commitSegVis(): void {
  void saveConfig(ctx.config)
  requestRender()
}

// seg-vis 系の共通枠: SegMeta/visibility を解決 → fn で更新 → save + render。
// 解決できない (key/seg 欠落・visibility 未設定) 場合は何もしない (旧 onSegVisChange の early return と等価)。
function withSegVis(t: HTMLElement, fn: (c: SegVisCtx) => void): void {
  const c = resolveSegVis(t)
  if (!c) return
  fn(c)
  commitSegVis()
}

function withSegVisLeaf(t: HTMLElement, fn: (c: SegVisLeafCtx) => void): void {
  const c = resolveSegVis(t)
  if (!c) return
  const idx = Number(t.dataset.idx)
  const leaf = c.vis.conditions[idx]
  if (!leaf) return
  fn({ ...c, idx, leaf })
  commitSegVis()
}

function onSegVisCombinator(t: HTMLElement): void {
  withSegVis(t, ({ vis, val }) => {
    vis.combinator = val === 'or' ? 'or' : 'and'
  })
}

function onSegVisDisplayUi(t: HTMLElement): void {
  withSegVis(t, ({ vis, val }) => {
    // 提示先: Inline(空) = display 削除 / それ以外 = ui 設定 (text/durationMs は保持)。
    const uis: ReadonlySet<string> = new Set(['toast', 'notification'])
    if (uis.has(val)) vis.display = { ...vis.display, ui: val as DisplayUi }
    else delete vis.display
  })
}

function onSegVisDisplayText(t: HTMLElement): void {
  withSegVis(t, ({ vis, val }) => {
    if (vis.display) {
      const text = val.trim().slice(0, 80)
      if (text) vis.display.text = text
      else delete vis.display.text
    }
  })
}

function onSegVisDisplaySecs(t: HTMLElement): void {
  withSegVis(t, ({ vis, val }) => {
    if (vis.display) vis.display.durationMs = clamp(Number(val), 1, 60) * 1000
  })
}

function onSegVisLeafKind(t: HTMLElement): void {
  withSegVisLeaf(t, ({ vis, ref, segId, val, idx }) => {
    vis.conditions[idx] = newLeafOfKind(val, ref, segId)
  })
}

function onSegVisLeafOp(t: HTMLElement): void {
  withSegVisLeaf(t, ({ leaf, val }) => {
    if (leaf.kind === 'threshold') leaf.op = val === 'lte' ? 'lte' : 'gte'
  })
}

function onSegVisLeafValue(t: HTMLElement): void {
  withSegVisLeaf(t, ({ leaf, val }) => {
    if (leaf.kind === 'threshold') leaf.value = clamp(Number(val), 0, 100)
  })
}

function onSegVisLeafHold(t: HTMLElement): void {
  withSegVisLeaf(t, ({ leaf, val }) => {
    if (leaf.kind === 'onChange') leaf.holdMs = clamp(Number(val), 1, 60) * 1000
  })
}

function onSegVisLeafSeg(t: HTMLElement): void {
  withSegVisLeaf(t, ({ leaf, segId, val }) => {
    // 対象 segment を切替。self を選んだら省略形に戻す (後方互換・config churn 回避)。
    if (leaf.kind === 'present') leaf.seg = val
    else if (leaf.kind === 'threshold' || leaf.kind === 'onChange') {
      if (val === segId) delete leaf.seg
      else leaf.seg = val
    }
  })
}

function onSegVisLeafAbsent(t: HTMLElement): void {
  withSegVisLeaf(t, ({ leaf, val }) => {
    if (leaf.kind === 'present') leaf.absent = val === 'absent'
  })
}

export const CHANGE_ACTIONS: Record<string, ChangeHandler> = {
  'profile-switch': (_t, e) => onProfileSwitch(e),
  'opt-set': (_t, e) => onOptionChange(e),
  'page-rename': (_t, e) => onPageRename(e),
  'seg-vis-combinator': (t) => onSegVisCombinator(t),
  'seg-vis-display-ui': (t) => onSegVisDisplayUi(t),
  'seg-vis-display-text': (t) => onSegVisDisplayText(t),
  'seg-vis-display-secs': (t) => onSegVisDisplaySecs(t),
  'seg-vis-leaf-kind': (t) => onSegVisLeafKind(t),
  'seg-vis-leaf-op': (t) => onSegVisLeafOp(t),
  'seg-vis-leaf-value': (t) => onSegVisLeafValue(t),
  'seg-vis-leaf-hold': (t) => onSegVisLeafHold(t),
  'seg-vis-leaf-seg': (t) => onSegVisLeafSeg(t),
  'seg-vis-leaf-absent': (t) => onSegVisLeafAbsent(t),
}

export function onChange(e: Event): void {
  const t = e.target as HTMLElement
  CHANGE_ACTIONS[t.dataset.action ?? '']?.(t, e)
}

// ページ名の変更 (rename input の change)。現在編集中ページ (pageEditingIdx) に作用する。
// requestRender() しない (input フォーカスを保つ。値は DOM が保持)。
function onPageRename(e: Event): void {
  const t = e.target as HTMLInputElement
  const raw = Number(t.dataset.pageIdx)
  const i = Number.isInteger(raw) ? raw : ctx.pageEditingIdx
  const page = activeView(ctx.config).pages?.[i]
  if (!page) return
  page.name = t.value.trim().slice(0, 24) || `Page ${i + 1}`
  void saveConfig(ctx.config)
}

// Preset select の変更で active profile を切替える。enabledSourceIds が変わるため
// fetch 範囲も更新する (applyProfileChange)。
function onProfileSwitch(e: Event): void {
  const id = (e.target as HTMLSelectElement).value
  if (!id || id === ctx.config.activeProfileId) return
  setActiveProfile(ctx.config, id)
  applyProfileChange()
}

// 提案バナーの承認: Phase 2 の切替を呼ぶ (自動適用ではなくユーザー操作を起点にする)。
// 提案先が存在しなければ何もしない (取り違え防止)。切替後は applyProfileChange が提案を再計算する。
export function onSuggestAccept(): void {
  const s = ctx.currentSuggestion
  if (!s || s.profileId === ctx.config.activeProfileId) return
  if (!ctx.config.profiles.some((p) => p.id === s.profileId)) return
  setActiveProfile(ctx.config, s.profileId)
  applyProfileChange()
}

// 表示オプション (#36) の select / number 変更を素材へ書き込む (clock は SegMeta.format に合成)。
// saveConfig が config-changed を dispatch → glass が loadConfig して実機描画にも反映。
function onOptionChange(e: Event): void {
  const t = e.target as HTMLSelectElement | HTMLInputElement
  applyOptionChange(t.dataset, t.value)
}

// 表示オプション 1 値の適用 (change 経路 = select/number、click 経路 = toggle で共通)。
// scope で segment/source を分け、kind による型変換と clamp は options.ts (setSegmentOption/setSourceOption)
// が行う。source 単位で再取得が要るオプションは当該 source を再 fetch する。
export function applyOptionChange(ds: DOMStringMap, rawValue: unknown): void {
  const key = ds.key
  const scope = ds.scope
  const fieldId = ds.field
  if (!key || !fieldId || (scope !== 'segment' && scope !== 'source')) return
  const ref = parseKey(key)
  let ok = false
  if (scope === 'segment') {
    const segId = ds.seg
    if (!segId) return
    ok = setSegmentOption(ctx.config, ref.sourceId, ref.groupId, segId, fieldId, rawValue)
  } else {
    ok = setSourceOption(ctx.config, ref.sourceId, fieldId, rawValue)
    if (ok) {
      // 新しい options を store の defs へ反映してから再取得する。defs は config のクローンのため、
      // setSourcesFromConfig で同期しないと client producer が旧 options で fetch してしまう (#36 が
      // #40 へ先送りした「単位変更の即時反映」ギャップ)。urlset 不変なので他 source は再 fetch されない。
      setSourcesFromConfig(ctx.config)
      refreshSourceById(ref.sourceId)
    }
  }
  if (!ok) return
  void saveConfig(ctx.config)
  requestRender()
}

// kind 切替時の新 leaf 既定値。present は兄弟必須なので最初の兄弟を対象にする。
// threshold は host が percent を持たない場合、同 group の percent を持つ兄弟を既定対象にする
// (self だと percent 欠落で常に na になり機能しないため)。
function newLeafOfKind(kind: string, ref: GroupRef, hostId: string): VisibilityLeaf {
  if (kind === 'present') {
    const sib = (ctx.config.groups[ref.sourceId]?.[ref.groupId]?.segments ?? [])
      .map((s) => s.id)
      .find((id) => id !== hostId)
    return { kind: 'present', seg: sib ?? '' }
  }
  if (kind === 'threshold') {
    const choices = segChoicesFor(ref)
    const leaf: VisibilityLeaf = { kind: 'threshold', op: 'gte', value: 80 }
    if (!choices.find((c) => c.id === hostId)?.hasPct) {
      const tgt = choices.find((c) => c.hasPct && c.id !== hostId)?.id
      if (tgt) leaf.seg = tgt
    }
    return leaf
  }
  return { kind: 'onChange', holdMs: 5000 }
}

// 編集中ソースの URL を検証・更新し、store に反映する。
export async function runConnectionTest(): Promise<void> {
  const input = ctx.root?.querySelector<HTMLInputElement>('.field-row input[type="text"]')
  const url = (input?.value ?? '').trim()
  if (!url || !ctx.editingSourceId) return
  ctx.testUrl = url
  ctx.testState = 'testing'
  ctx.testError = ''
  requestRender()
  const clean = url.replace(/\/+$/, '')
  // fetchMachineFrom は machineId が非空 string のときだけ object を返す (parseMachineInfo)。
  // null は「接続失敗」または「接続成功だが machineId 不明」を意味し、後者でも空 machineId を
  // reconcile に渡さない (空 machineId による別マシン誤合流 = データ破壊を構造的に防ぐ)。
  const m = await fetchMachineFrom(clean)
  if (!m) {
    ctx.testState = 'error'
    ctx.testError = 'Connection failed'
    requestRender()
    return
  }
  ctx.editMachine = m
  const src = sourceById(ctx.config, ctx.editingSourceId)
  if (src) {
    // テストした経路を urls に足す (上書きしない = 既存経路を温存し複数経路を束ねる)。
    if (!src.urls.includes(clean)) src.urls.push(clean)
    src.url ??= clean // 後方互換の主 url は初回のみ設定
    src.label = m.label
    // machineId を反映して id を安定化する。同 machineId の既存 source への合流 / 旧 randomUUID の
    // id 付け替え / tombstone からの view 復元はすべて reconcileSourceMachine が担う。
    const settled = reconcileSourceMachine(ctx.config, ctx.editingSourceId, m.machineId, clean)
    if (settled) ctx.editingSourceId = settled.id // 合流/再 key で id が変わったら追従
  }
  await saveConfig(ctx.config)
  ctx.testState = 'ok'
  setSourcesFromConfig(ctx.config) // store に新 URL を反映 → 取得 → onStoreUpdate で再描画
  requestRender()
}
