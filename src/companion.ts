import {
  type Config,
  emptyConfig,
  ensureMachine,
  loadConfig,
  type MachineCfg,
  saveConfig,
} from './config'
import {
  type ClaudeLimits,
  type CodexLimits,
  fetchClaudeLimits,
  fetchCodexLimits,
  fetchMachine,
  fetchUsage,
  type MachineInfo,
  type Usage,
} from './data'
import { SOURCES, sourceById } from './sources'

// companion (スマホ WebView) の Home / Machine Edit。bridge は不要 (API fetch + config 永続化)。
let view: 'home' | 'machine-edit' = 'home'
let machine: MachineInfo | null = null
let config: Config = emptyConfig()
let claude: ClaudeLimits | null = null
let codex: CodexLimits | null = null
let usage: Usage | null = null
let root: HTMLElement | null = null

function activeCfg(): MachineCfg | null {
  const id = config.activeMachine
  return id ? (config.machines[id] ?? null) : null
}

function metricValue(srcId: string, metricId: string): string {
  if (srcId === 'claude-code') {
    if (metricId === 'session') return claude?.five_hour ? `${claude.five_hour.utilization}%` : '—'
    if (metricId === 'weekly') return claude?.seven_day ? `${claude.seven_day.utilization}%` : '—'
    if (metricId === 'sonnet')
      return claude?.seven_day_sonnet ? `${claude.seven_day_sonnet.utilization}%` : '—'
    if (metricId === 'opus')
      return claude?.seven_day_opus ? `${claude.seven_day_opus.utilization}%` : '—'
    if (metricId === 'cost') return usage?.estCostUsd != null ? `$${usage.estCostUsd}` : '—'
    if (metricId === 'msgs') return usage?.messages != null ? String(usage.messages) : '—'
  } else if (srcId === 'codex') {
    if (metricId === '5h') return codex?.primary ? `${codex.primary.usedPercent}%` : '—'
    if (metricId === 'weekly') return codex?.secondary ? `${codex.secondary.usedPercent}%` : '—'
  }
  return '—'
}

function metricName(srcId: string, metricId: string): string {
  return sourceById(srcId)?.metrics.find((m) => m.id === metricId)?.name ?? metricId
}

function glassPreviewHtml(): string {
  const mc = activeCfg()
  const avail = machine?.availableSources ?? []
  const lines: string[] = []
  if (mc) {
    for (const id of mc.sourceOrder) {
      const scfg = mc.sources[id]
      const src = sourceById(id)
      if (!scfg?.enabled || !avail.includes(id) || !src) continue
      const ms = scfg.metrics
        .filter((m) => m.enabled)
        .map((m) => `${metricName(id, m.id)} ${metricValue(id, m.id)}`)
        .join('  ')
      lines.push(`${src.name}  ${ms}`)
    }
  }
  const body = lines.length
    ? lines.map((l) => `<span class="grow">${l}</span>`).join('')
    : '<span class="grow">(no metric)</span>'
  const hint = config.glassHints ? '<span class="grow ghint">swipe: 詳細  tap: 戻る</span>' : ''
  return `<div class="glass-screen"><div>${body}</div>${hint}</div>`
}

function renderSourceList(): string {
  const mc = activeCfg()
  if (!mc) return ''
  const avail = machine?.availableSources ?? []
  return SOURCES.map((src) => {
    const scfg = mc.sources[src.id]
    if (!avail.includes(src.id) || !scfg) {
      return `<div class="src dim"><div class="src-head"><span class="src-grip">⋮⋮</span>
        <span class="src-caret">▸</span><span class="src-name">${src.name}</span>
        <span class="src-note">未検出</span><button class="tg" disabled></button></div></div>`
    }
    const caret = scfg.expanded ? '▾' : '▸'
    const metrics = scfg.expanded
      ? `<div class="src-metrics">${src.metrics
          .map((m) => {
            const enabled = scfg.metrics.find((x) => x.id === m.id)?.enabled ?? false
            return `<div class="metric-row"><span class="mgrip">⋮⋮</span>
              <span class="mname">${m.name}</span><span class="mval">${metricValue(src.id, m.id)}</span>
              <button class="tg sm ${enabled ? 'on' : ''}" data-action="toggle-metric" data-src="${src.id}" data-metric="${m.id}"></button></div>`
          })
          .join('')}</div>`
      : ''
    return `<div class="src"><div class="src-head"><span class="src-grip">⋮⋮</span>
      <span class="src-caret" data-action="expand" data-src="${src.id}">${caret}</span>
      <span class="src-name" data-action="expand" data-src="${src.id}">${src.name}</span>
      <button class="tg ${scfg.enabled ? 'on' : ''}" data-action="toggle-source" data-src="${src.id}"></button></div>${metrics}</div>`
  }).join('')
}

function renderHome(): string {
  const label = machine?.label ?? '(未接続)'
  const ids = Object.keys(config.machines)
  const opts = ids.length
    ? ids
        .map(
          (id) =>
            `<option value="${id}" ${id === config.activeMachine ? 'selected' : ''}>${id === machine?.machineId ? label : id}</option>`,
        )
        .join('')
    : `<option selected>${label}</option>`
  return `
    <div class="cmp-label">Machine</div>
    <div class="machine-bar">
      <span class="conn-dot ${machine ? '' : 'off'}" title="${machine ? '接続中' : '未接続'}"></span>
      <select class="machine-select" data-action="select-machine">${opts}<option value="__add__">+ マシンを追加…</option></select>
      <button class="gear-btn" data-action="edit-machine" title="このマシンの設定">⚙</button>
    </div>

    <div class="cmp-label">表示設定 (ドラッグで並べ替え)</div>
    ${renderSourceList()}
    <div class="src"><div class="src-head">
      <span class="src-name" style="font-size:var(--fs-md);font-weight:500;">glass の操作ヒントを表示</span>
      <button class="tg sm ${config.glassHints ? 'on' : ''}" data-action="toggle-hints"></button></div></div>

    <div class="cmp-label">Glass プレビュー</div>
    <div class="gpv"><div class="gpv-cap">G2 576×288</div>
      <div class="gpv-screen">${glassPreviewHtml()}</div></div>
  `
}

function renderMachineEdit(): string {
  const m = machine
  const has = (id: string) => m?.availableSources.includes(id) ?? false
  const detected = m
    ? `<div class="field"><label>マシン名 (hostname を自動取得)</label><div class="autoval">${m.label}</div></div>
       <div class="field"><label>machineId (自動)</label><div class="autoval mono">${m.machineId}</div></div>
       <div class="field"><label>利用可能なツール (自動検出)</label>
         <div class="detect">
           <span class="${has('claude-code') ? 'ok' : 'no'}">Claude Code ${has('claude-code') ? '✓' : '✗'}</span>
           <span class="${has('codex') ? 'ok' : 'no'}">Codex ${has('codex') ? '✓' : '✗'}</span>
           <span class="no">Gemini ✗</span>
         </div></div>
       <div class="status-ok">✓ 接続OK</div>`
    : '<div class="cmp-sub">接続テストすると、マシン名・利用可能ツールを自動取得します。</div>'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">← Home</button>
      <span class="h-title">Machine 設定</span><span></span></div>
    <div class="field"><label>接続先 (Mac の dev server URL)</label>
      <div class="field-row">
        <input type="text" value="${location.origin}" placeholder="http://192.168.1.5:5173" />
        <button class="test-btn" data-action="test">接続テスト</button>
      </div>
      <span class="help-link" data-action="help">ローカルサーバーの設定方法 →</span>
    </div>
    ${detected}
  `
}

function render(): void {
  if (root) root.innerHTML = view === 'machine-edit' ? renderMachineEdit() : renderHome()
}

async function onClick(e: MouseEvent): Promise<void> {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
  if (!t || t.tagName === 'SELECT') return
  const mc = activeCfg()
  switch (t.dataset.action) {
    case 'edit-machine':
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
    default:
      break // test / help は Phase2 以降
  }
}

async function onChange(e: Event): Promise<void> {
  const t = (e.target as HTMLElement).closest(
    '[data-action="select-machine"]',
  ) as HTMLSelectElement | null
  if (!t) return
  if (t.value === '__add__') {
    view = 'machine-edit'
    render()
  } else {
    config.activeMachine = t.value
    await saveConfig(config)
    render()
  }
}

async function refreshData(): Promise<void> {
  // claude / usage は速いので先に描画する。
  // codex は app-server 起動 (~1.5-3s) で遅いため分離し、取れ次第 再描画する
  // (Promise.all だと codex 待ちで claude/usage の表示まで遅れる)。
  const [c, u] = await Promise.all([fetchClaudeLimits(), fetchUsage()])
  claude = c
  usage = u
  render()
  codex = await fetchCodexLimits()
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
    ensureMachine(config, machine.machineId, machine.availableSources)
    await saveConfig(config)
  }
  render()
  await refreshData()
  setInterval(() => void refreshData(), 60_000)
}
