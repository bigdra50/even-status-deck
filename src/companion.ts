import Sortable from 'sortablejs'
import {
  addServer,
  type Config,
  emptyConfig,
  loadConfig,
  type MachineCfg,
  type SourceCfg,
  saveConfig,
  syncMachineWithStatus,
  upsertActiveServer,
} from './config'
import { fetchMachineFrom, type MachineInfo } from './data'
import { esc } from './escape'
import { hudLine } from './glass-render'
import type { Group } from './status-types'
import { getStatus, setSourceUrl, startPolling, subscribe } from './store'

// companion (スマホ WebView) の Home / Machine Edit。bridge は不要 (API fetch + config 永続化)。
// 表示要素は status (provider 集約) から取得し、設定は status の group/segment に対応。
let view: 'home' | 'machine-edit' = 'home'
let machine: MachineInfo | null = null
let config: Config = emptyConfig()
let root: HTMLElement | null = null

// Machine Edit の接続テスト状態
let testState: 'idle' | 'testing' | 'ok' | 'error' = 'idle'
let testError = ''
let testUrl = ''

function activeCfg(): MachineCfg | null {
  const id = config.activeMachine
  return id ? (config.machines[id] ?? null) : null
}

function statusGroups(): Map<string, Group> {
  const m = new Map<string, Group>()
  for (const g of getStatus()?.groups ?? []) m.set(g.id, g)
  return m
}

// active マシンの config を status に合わせ、追加があれば保存する。
function syncActiveCfg(): void {
  const mc = activeCfg()
  const s = getStatus()
  if (mc && s && syncMachineWithStatus(mc, s)) void saveConfig(config)
}

function glassPreviewHtml(): string {
  const mc = activeCfg()
  const groups = statusGroups()
  const lines: string[] = []
  if (mc) {
    for (const gid of mc.sourceOrder) {
      const scfg = mc.sources[gid]
      const g = groups.get(gid)
      if (!scfg?.enabled || !g) continue
      const segs = new Map(g.segments.map((s) => [s.id, s]))
      const parts: string[] = []
      for (const m of scfg.metrics) {
        const seg = segs.get(m.id)
        if (m.enabled && seg) parts.push(`${esc(seg.label)} ${esc(seg.value)}`)
      }
      if (parts.length) lines.push(`${esc(g.label)}  ${parts.join('  ')}`)
    }
  }
  const metrics = lines.length
    ? lines.map((l) => `<span class="grow">${l}</span>`).join('')
    : '<span class="grow">(no metric)</span>'
  const hud = `<span class="grow ghud">${hudLine()}</span>`
  const hint = config.glassHints ? '<span class="grow ghint">swipe: detail  tap: back</span>' : ''
  return `<div class="glass-screen"><div>${hud}${metrics}</div>${hint}</div>`
}

// group 1 件の行。label/value は status から、enabled/order/expanded は config から。
function renderSourceRow(g: Group, scfg: SourceCfg): string {
  const caret = scfg.expanded ? '▾' : '▸'
  const segs = new Map(g.segments.map((s) => [s.id, s]))
  const metrics = scfg.expanded
    ? `<div class="src-metrics" data-src="${g.id}">${scfg.metrics
        .map((m) => {
          const seg = segs.get(m.id)
          if (!seg) return ''
          return `<div class="metric-row"><span class="mgrip">⋮⋮</span>
              <span class="mname">${esc(seg.label)}</span>
              <span class="mval">${esc(seg.value)}</span>
              <button class="tg sm ${m.enabled ? 'on' : ''}" data-action="toggle-metric" data-src="${esc(g.id)}" data-metric="${esc(m.id)}"></button></div>`
        })
        .join('')}</div>`
    : ''
  return `<div class="src" data-src="${esc(g.id)}"><div class="src-head"><span class="src-grip">⋮⋮</span>
    <span class="src-caret" data-action="expand" data-src="${esc(g.id)}">${caret}</span>
    <span class="src-name" data-action="expand" data-src="${esc(g.id)}">${esc(g.label)}</span>
    <button class="tg ${scfg.enabled ? 'on' : ''}" data-action="toggle-source" data-src="${esc(g.id)}"></button></div>${metrics}</div>`
}

// status の group を config 順で並べる (ドラッグ並べ替え対象 → #source-list 内)。
function renderAvailableSources(): string {
  const mc = activeCfg()
  if (!mc) return ''
  const groups = statusGroups()
  return mc.sourceOrder
    .filter((id) => groups.has(id) && mc.sources[id])
    .map((id) => {
      const g = groups.get(id)
      const scfg = mc.sources[id]
      return g && scfg ? renderSourceRow(g, scfg) : ''
    })
    .join('')
}

function renderHome(): string {
  const list = Object.values(config.machines)
  const opts = list.length
    ? list
        .map(
          (mc) =>
            `<option value="${esc(mc.id)}" ${mc.id === config.activeMachine ? 'selected' : ''}>${esc(mc.label || mc.id)}</option>`,
        )
        .join('')
    : `<option selected>${esc(machine?.label ?? '(未接続)')}</option>`
  return `
    <div class="cmp-label">Machine</div>
    <div class="machine-bar">
      <span class="conn-dot ${machine ? '' : 'off'}" title="${machine ? '接続中' : '未接続'}"></span>
      <select class="machine-select" data-action="select-machine">${opts}<option value="__add__">+ マシンを追加…</option></select>
      <button class="gear-btn" data-action="edit-machine" title="このマシンの設定">⚙</button>
    </div>

    <div class="cmp-label">表示設定 (グリップ ⋮⋮ をドラッグで並べ替え)</div>
    <div id="source-list">${renderAvailableSources()}</div>
    <div class="src"><div class="src-head">
      <span class="src-name" style="font-size:var(--fs-md);font-weight:500;">glass の操作ヒントを表示</span>
      <button class="tg sm ${config.glassHints ? 'on' : ''}" data-action="toggle-hints"></button></div></div>

    <div class="cmp-label">Glass プレビュー</div>
    <div class="gpv"><div class="gpv-cap">G2 576×288</div>
      <div class="gpv-screen">${glassPreviewHtml()}</div></div>
  `
}

function renderDetected(): string {
  const m = machine
  if (!m) return ''
  const has = (id: string) => m.availableSources.includes(id)
  return `<div class="field"><label>マシン名 (hostname を自動取得)</label><div class="autoval">${esc(m.label)}</div></div>
     <div class="field"><label>machineId (自動)</label><div class="autoval mono">${esc(m.machineId)}</div></div>
     <div class="field"><label>利用可能なツール (自動検出)</label>
       <div class="detect">
         <span class="${has('claude-code') ? 'ok' : 'no'}">Claude Code ${has('claude-code') ? '✓' : '✗'}</span>
         <span class="${has('codex') ? 'ok' : 'no'}">Codex ${has('codex') ? '✓' : '✗'}</span>
         <span class="no">Gemini ✗</span>
       </div></div>`
}

// 接続テストの状態を表示する (idle / testing / ok / error)。
function renderTestStatus(): string {
  if (testState === 'testing') return '<div class="status-testing">⋯ 接続中…</div>'
  if (testState === 'ok') return `<div class="status-ok">✓ 接続OK</div>${renderDetected()}`
  if (testState === 'error')
    return `<div class="status-err">✗ 接続失敗: ${esc(testError)}</div>
      <div class="cmp-sub">URL とローカルサーバーの起動を確認してください。</div>`
  return '<div class="cmp-sub">接続テストすると、マシン名・利用可能ツールを自動取得します。</div>'
}

function renderMachineEdit(): string {
  const url = testUrl || location.origin
  const testing = testState === 'testing'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">← Home</button>
      <span class="h-title">Machine 設定</span><span></span></div>
    <div class="field"><label>接続先 (Mac の dev server URL)</label>
      <div class="field-row">
        <input type="text" value="${esc(url)}" placeholder="http://192.168.1.5:5173" />
        <button class="test-btn" data-action="test" ${testing ? 'disabled' : ''}>${testing ? '…' : '接続テスト'}</button>
      </div>
      <span class="help-link" data-action="help">ローカルサーバーの設定方法 →</span>
    </div>
    ${renderTestStatus()}
  `
}

function render(): void {
  if (!root) return
  root.innerHTML = view === 'machine-edit' ? renderMachineEdit() : renderHome()
  if (view === 'home') attachSortables()
}

// glass プレビューのみ部分更新 (並べ替え中に全体 re-render すると Sortable が壊れるため)。
function updateGlassPreview(): void {
  const el = root?.querySelector('.gpv-screen')
  if (el) el.innerHTML = glassPreviewHtml()
}

// SortableJS の drag handle。render() のたびに作り直す (古いインスタンスは破棄)。
let sortables: Sortable[] = []
function attachSortables(): void {
  for (const s of sortables) s.destroy()
  sortables = []
  const list = document.getElementById('source-list')
  if (list) {
    sortables.push(
      Sortable.create(list, {
        handle: '.src-grip',
        animation: 150,
        onEnd: (e) => onSourceReorder(e.oldIndex, e.newIndex),
      }),
    )
  }
  for (const el of document.querySelectorAll<HTMLElement>('.src-metrics')) {
    const srcId = el.dataset.src ?? ''
    sortables.push(
      Sortable.create(el, {
        handle: '.mgrip',
        animation: 150,
        onEnd: (e) => onMetricReorder(srcId, e.oldIndex, e.newIndex),
      }),
    )
  }
}

// 利用可能ソースの並べ替え。indices は #source-list 内 (= 利用可能サブセット) 基準。
// 利用不可ソースは sourceOrder 末尾に温存する。
function onSourceReorder(oldIndex?: number, newIndex?: number): void {
  const mc = activeCfg()
  if (!mc || oldIndex == null || newIndex == null || oldIndex === newIndex) return
  const groups = statusGroups()
  const ordered = mc.sourceOrder.filter((id) => groups.has(id) && mc.sources[id])
  const [moved] = ordered.splice(oldIndex, 1)
  if (!moved) return
  ordered.splice(newIndex, 0, moved)
  const rest = mc.sourceOrder.filter((id) => !ordered.includes(id))
  mc.sourceOrder = [...ordered, ...rest]
  void saveConfig(config)
  updateGlassPreview()
}

// メトリックの並べ替え。indices は scfg.metrics 基準。
function onMetricReorder(srcId: string, oldIndex?: number, newIndex?: number): void {
  const scfg = activeCfg()?.sources[srcId]
  if (!scfg || oldIndex == null || newIndex == null || oldIndex === newIndex) return
  const [moved] = scfg.metrics.splice(oldIndex, 1)
  if (!moved) return
  scfg.metrics.splice(newIndex, 0, moved)
  void saveConfig(config)
  updateGlassPreview()
}

async function onClick(e: MouseEvent): Promise<void> {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
  if (!t || t.tagName === 'SELECT') return
  const mc = activeCfg()
  switch (t.dataset.action) {
    case 'edit-machine':
      // 既に接続済みマシンを編集 → 検出結果と保存済み URL を表示
      testState = machine ? 'ok' : 'idle'
      testUrl = activeCfg()?.url ?? ''
      view = 'machine-edit'
      render()
      break
    case 'home':
      view = 'home'
      render()
      break
    case 'expand': {
      const s = mc?.sources[t.dataset.src ?? '']
      if (s) {
        s.expanded = !s.expanded
        await saveConfig(config)
        render()
      }
      break
    }
    case 'toggle-source': {
      const s = mc?.sources[t.dataset.src ?? '']
      if (s) {
        s.enabled = !s.enabled
        await saveConfig(config)
        render()
      }
      break
    }
    case 'toggle-metric': {
      const s = mc?.sources[t.dataset.src ?? '']
      const m = s?.metrics.find((x) => x.id === t.dataset.metric)
      if (m) {
        m.enabled = !m.enabled
        await saveConfig(config)
        render()
      }
      break
    }
    case 'toggle-hints':
      config.glassHints = !config.glassHints
      await saveConfig(config)
      render()
      break
    case 'test':
      await runConnectionTest()
      break
    case 'help':
      // 同梱の設定ガイド (public/help.html) を別タブで開く
      window.open('/help.html', '_blank')
      break
    default:
      break
  }
}

// 入力された URL に /api/machine を投げて接続を検証し、状態 (testing/ok/error) を更新する。
// 成功時はその URL を共有 store の接続先に設定し (store が status を取得・配信)、永続化する。
async function runConnectionTest(): Promise<void> {
  const input = root?.querySelector<HTMLInputElement>('.field-row input[type="text"]')
  const url = (input?.value ?? '').trim() || location.origin
  testUrl = url
  testState = 'testing'
  testError = ''
  render()
  const clean = url.replace(/\/+$/, '')
  const m = await fetchMachineFrom(clean)
  if (!m) {
    testState = 'error'
    testError = '接続に失敗しました'
    render()
    return
  }
  machine = m
  // active ソースの URL/label を更新 (無ければ作成)。不変 ID は保持。URL を永続化する。
  upsertActiveServer(config, clean, m.label)
  await saveConfig(config)
  testState = 'ok'
  setSourceUrl(clean) // store が新 URL で status 取得 → onStoreUpdate で再描画
  render()
}

async function onChange(e: Event): Promise<void> {
  const t = (e.target as HTMLElement).closest(
    '[data-action="select-machine"]',
  ) as HTMLSelectElement | null
  if (!t) return
  if (t.value === '__add__') {
    // 新規マシン追加 → 空の server ソースを作り active に。URL は接続テストで設定
    addServer(config, '新しいマシン')
    await saveConfig(config)
    testState = 'idle'
    testUrl = ''
    view = 'machine-edit'
    render()
  } else {
    config.activeMachine = t.value
    // 切り替え先ソースの保存済み URL に store の接続先を切り替えて再取得
    const url = config.machines[t.value]?.url
    if (url) {
      setSourceUrl(url)
      machine = await fetchMachineFrom(url)
    }
    await saveConfig(config)
    render()
  }
}

// store の status 更新で再描画する (新 group/segment を config に取り込み)。
function onStoreUpdate(): void {
  syncActiveCfg()
  render()
}

// 起動時の接続: machine を取得して config の machine entry / activeMachine を確立し、
// store の接続先を設定する。machine が取れなければ store URL だけ設定する。
async function connectTo(url: string): Promise<void> {
  const m = await fetchMachineFrom(url)
  if (m) machine = m
  const mc = activeCfg()
  if (!mc) {
    // 初回: この接続先を server ソースとして登録 (不変 ID 採番)
    addServer(config, m?.label ?? 'Local', url)
    await saveConfig(config)
  } else if (!mc.url) {
    mc.url = url
    if (m) mc.label = m.label
    await saveConfig(config)
  }
  setSourceUrl(url)
}

export async function mountCompanion(el: HTMLElement): Promise<void> {
  root = el
  el.addEventListener('click', (e) => void onClick(e))
  el.addEventListener('change', (e) => void onChange(e))
  subscribe(onStoreUpdate)

  // bridge 接続前は永続 config を読めない (memory のみ)。接続先は保存済み URL か、
  // 無ければ同一オリジン (dev-URL sideload / ブラウザ dev) を既定にする。
  config = await loadConfig()
  await connectTo(activeCfg()?.url ?? location.origin)
  startPolling()
  render()
}

// bridge 接続後に呼ぶ。mountCompanion は bridge 接続前に走るため永続 config を
// 読めない。ここで読み直し、前回接続した URL を復元して再接続する。
export async function onCompanionBridgeReady(): Promise<void> {
  config = await loadConfig()
  // connectTo 内の setSourceUrl が URL 変化時に refresh する (同一 URL なら mount の取得を流用)。
  await connectTo(activeCfg()?.url ?? location.origin)
  render()
}
