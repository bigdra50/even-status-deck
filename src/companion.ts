import Sortable from 'sortablejs'
import {
  type Config,
  emptyConfig,
  ensureMachine,
  loadConfig,
  type MachineCfg,
  type SourceCfg,
  saveConfig,
  syncMachineWithStatus,
} from './config'
import { fetchMachine, fetchStatus, type MachineInfo, setDataBase } from './data'
import { esc } from './escape'
import { hudLine } from './glass-render'
import type { Group, StatusDoc } from './status-types'

// companion (スマホ WebView) の Home / Machine Edit。bridge は不要 (API fetch + config 永続化)。
// 表示要素は status (provider 集約) から取得し、設定は status の group/segment に対応。
let view: 'home' | 'machine-edit' = 'home'
let machine: MachineInfo | null = null
let config: Config = emptyConfig()
let status: StatusDoc | null = null
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
  for (const g of status?.groups ?? []) m.set(g.id, g)
  return m
}

// active マシンの config を status に合わせ、追加があれば保存する。
function syncActiveCfg(): void {
  const mc = activeCfg()
  if (mc && status && syncMachineWithStatus(mc, status)) void saveConfig(config)
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
  const label = machine?.label ?? '(未接続)'
  const ids = Object.keys(config.machines)
  const opts = ids.length
    ? ids
        .map(
          (id) =>
            `<option value="${esc(id)}" ${id === config.activeMachine ? 'selected' : ''}>${esc(id === machine?.machineId ? label : id)}</option>`,
        )
        .join('')
    : `<option selected>${esc(label)}</option>`
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
// 成功時はその URL をデータ取得のベースに切り替え、マシン情報を反映する。
async function runConnectionTest(): Promise<void> {
  const input = root?.querySelector<HTMLInputElement>('.field-row input[type="text"]')
  const url = (input?.value ?? '').trim() || location.origin
  testUrl = url
  testState = 'testing'
  testError = ''
  render()
  try {
    const clean = url.replace(/\/+$/, '')
    const res = await fetch(`${clean}/api/machine`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const m = (await res.json()) as MachineInfo
    machine = m
    setDataBase(clean)
    // 接続したマシンをアクティブにし、URL を永続化 (次回起動時に復元する)
    config.activeMachine = m.machineId
    const mc = ensureMachine(config, m.machineId)
    mc.url = clean
    await saveConfig(config)
    testState = 'ok'
    render()
    await refreshData() // 新しいベース URL で status を取り直す
  } catch (err) {
    testState = 'error'
    testError = err instanceof Error ? err.message : '接続に失敗しました'
    render()
  }
}

async function onChange(e: Event): Promise<void> {
  const t = (e.target as HTMLElement).closest(
    '[data-action="select-machine"]',
  ) as HTMLSelectElement | null
  if (!t) return
  if (t.value === '__add__') {
    // 新規マシン追加 → URL 未入力・idle 状態で開始
    testState = 'idle'
    testUrl = ''
    view = 'machine-edit'
    render()
  } else {
    config.activeMachine = t.value
    // 切り替え先マシンの保存済み URL にデータ取得先を切り替えて再取得
    const url = config.machines[t.value]?.url
    if (url) {
      setDataBase(url)
      machine = await fetchMachine()
    }
    await saveConfig(config)
    render()
    await refreshData()
  }
}

async function refreshData(): Promise<void> {
  // 表示要素は /api/status (provider 集約) 1 本で取得する。
  const s = await fetchStatus()
  if (s) {
    status = s
    syncActiveCfg() // 新しい group/segment を config に取り込み (変更時のみ保存)
  }
  render()
}

export async function mountCompanion(el: HTMLElement): Promise<void> {
  root = el
  el.addEventListener('click', (e) => void onClick(e))
  el.addEventListener('change', (e) => void onChange(e))

  machine = await fetchMachine()
  config = await loadConfig()
  if (machine) {
    if (!config.activeMachine) config.activeMachine = machine.machineId
    ensureMachine(config, machine.machineId)
    await saveConfig(config)
  }
  render()
  await refreshData()
  setInterval(() => void refreshData(), 60_000)
}

// bridge 接続後に呼ぶ。mountCompanion は bridge 接続前に走るため永続 config を
// 読めない。ここで読み直し、前回接続した URL を復元して再接続する。
export async function onCompanionBridgeReady(): Promise<void> {
  config = await loadConfig()
  const url = config.activeMachine ? config.machines[config.activeMachine]?.url : undefined
  if (url) {
    setDataBase(url)
    const m = await fetchMachine()
    if (m) machine = m
  }
  render()
  await refreshData()
}
