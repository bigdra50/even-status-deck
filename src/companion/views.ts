// companion の画面/view 描画 (Home / Source Detail / Sources / Add Source / Source Edit) と
// プリセットバー。

import {
  activeProfile,
  DEFAULT_PROFILE_ID,
  isSourceEnabled,
  type SourceDef,
  sourceById,
  sourceUrl,
  sourceUrls,
} from '../config'
import { effectiveOwner } from '../display-identity'
import { esc } from '../escape'
import { icon } from '../icons'
import { renderDbgConsole } from './debug-console'
import { renderGlassSection } from './glass-edit'
import {
  renderSourceGroups,
  SOURCE_SECTIONS,
  sourceAddRow,
  sourceDotNote,
  sourceManageRow,
  sourceNavRow,
  sourceSection,
} from './rows'
import { ctx } from './state'

// ── Phase 4: プリセット切替の提案 (バナー) ──
// 提案バナー: 非モーダルで dismiss 可能 (Switch / × の 2 アクション)。glass は勝手に変えない。
// 提案が無ければ空文字 (Home から消える)。承認で Phase 2 の切替 (onSuggestAccept) を呼ぶ。
function renderSuggestionBanner(): string {
  const s = ctx.currentSuggestion
  if (!s) return ''
  const detail =
    s.matchCount === 1
      ? 'A connected source matches this preset.'
      : `${s.matchCount} connected sources match this preset.`
  return `
    <div class="suggest-banner" role="status">
      <span class="suggest-icon">${icon('sparkles', { size: 16 })}</span>
      <div class="suggest-text">
        <div class="suggest-title">Switch to <strong>${esc(s.profileName)}</strong>?</div>
        <div class="suggest-sub">${detail}</div>
      </div>
      <button class="suggest-accept" data-action="suggest-accept">Switch</button>
      <button class="suggest-dismiss" data-action="suggest-dismiss" title="Dismiss" aria-label="Dismiss">${icon('x', { size: 16 })}</button>
    </div>`
}

// ── Profile (プリセット) ──
// Home 最上部の状況セット切替。select で active を切替え、隣のボタンで追加/複製/リネーム/削除。
// Default (id 'default') は削除不可なので、active が Default のときは削除ボタンを無効化する。
function renderProfileBar(): string {
  const active = activeProfile(ctx.config)
  const options = ctx.config.profiles
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${p.id === active.id ? 'selected' : ''}>${esc(p.name)}</option>`,
    )
    .join('')
  // Default は削除不可 + profile が 1 個だけのときも削除不可 (最後の 1 個は残す)。
  const canDelete = active.id !== DEFAULT_PROFILE_ID && ctx.config.profiles.length > 1
  const delAttr = canDelete ? '' : 'disabled'
  return `
    <div class="cmp-label">Preset</div>
    <div class="profile-bar">
      <select class="profile-select" data-action="profile-switch" aria-label="Preset">${options}</select>
      <button class="gear-btn" data-action="profile-rename" title="Rename preset" aria-label="Rename preset">${icon('pencil', { size: 16 })}</button>
      <button class="gear-btn" data-action="profile-duplicate" title="Duplicate preset" aria-label="Duplicate preset">${icon('copy', { size: 16 })}</button>
      <button class="gear-btn" data-action="profile-add" title="Add preset" aria-label="Add preset">${icon('plus', { size: 16 })}</button>
      <button class="gear-btn danger" data-action="profile-delete" title="Delete preset" aria-label="Delete preset" ${delAttr}>${icon('trash', { size: 16 })}</button>
    </div>`
}

export function renderHome(): string {
  // 新 IA: この preset で有効な全 source (builtin 含む) を nav カードで出す。tap で Source Detail へ。
  // 旧 flat Items リスト (全 source 横断の group リスト) は廃止。中身の設定は Source Detail に移設。
  const sources = ctx.config.sources.filter((s) => isSourceEnabled(ctx.config, s.id))
  // provenance でセクション化 (Included / Connected / Extensions)。空セクションは描かない。
  const sourcesHtml = sources.length
    ? SOURCE_SECTIONS.map(({ key, label, hint }) => {
        const inSec = sources.filter((s) => sourceSection(s) === key)
        if (!inSec.length) return ''
        return `<div class="src-section" title="${esc(hint)}">${label}</div>${inSec.map(sourceNavRow).join('')}`
      }).join('')
    : '<div class="cmp-sub">No sources in this preset.</div>'
  return `
    ${renderSuggestionBanner()}
    ${renderProfileBar()}

    <div class="cmp-label cmp-label-row">Sources (this preset)<span class="cmp-actions"><button class="link-btn" data-action="manage-sources">Manage all</button></span></div>
    <div class="cmp-sub">Tap a source to toggle its items &amp; settings.</div>
    ${sourcesHtml}
    <button class="save-btn sm" data-action="open-add-source">${icon('plus', { size: 14 })} Add source</button>

    ${renderGlassSection()}

    ${renderDbgConsole()}
  `
}

// 画面2 (新 IA): Source Detail。1 source の group/segment トグル・表示オプション・条件を集約。
// groupRow をそのまま再利用するので機能の取りこぼし無し。owner はヘッダで編集 (source 単位・全 preset 共有)。
export function renderSourceDetail(): string {
  // 存在 かつ 現 preset で有効 な source のみ detail を出す。remove-from-preset/delete で
  // 無効/消滅したら Home へフォールバック (stale detail に居座らない)。
  const s =
    ctx.detailSourceId && isSourceEnabled(ctx.config, ctx.detailSourceId)
      ? sourceById(ctx.config, ctx.detailSourceId)
      : undefined
  if (!s) {
    ctx.view = 'home'
    return renderHome()
  }
  const isBuiltin = s.kind === 'builtin'
  const owner = effectiveOwner(s)
  const ownerEl = isBuiltin
    ? `<span class="owner-badge owner-fixed" title="Owner (code-owned)">${esc(owner)}</span>`
    : `<button class="owner-badge" data-action="edit-owner" data-src="${esc(s.id)}" title="Rename owner — distinguishes same-type data">${esc(owner)} ${icon('pencil', { size: 12 })}</button>`
  const { dotCls, note } = isBuiltin ? { dotCls: '', note: 'On-device' } : sourceDotNote(s)
  // 接続編集/削除(実体管理)は Sources(Manage all)、preset から外すのは Home の swipe→🗑 に集約。
  // Source Detail は「この preset での設定」に専念し、実体操作のボタンは置かない。
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">${icon('arrow-left', { size: 16 })} Sources</button>
      <span class="h-title">${esc(s.label)}</span><span></span></div>
    <div class="src-detail-head">
      <span class="conn-dot ${dotCls}"></span>${ownerEl}
      <span class="src-note" style="margin-left:auto">${esc(note)}</span>
    </div>
    <div class="cmp-sub">Toggles apply to <b>this preset</b>. Display options, show-when conditions and owner are <b>shared across all presets</b>.</div>
    <div id="detail-groups">${renderSourceGroups(s.id)}</div>
  `
}

// Sources 一覧: 全 source 実体 (preset 非依存)。編集・削除はここに集約。
export function renderSources(): string {
  // Manage all は URL を持つ server source のみ (client=Location は Home の Add/Remove で管理)。
  const sources = ctx.config.sources.filter((s) => s.kind === 'server')
  const html = sources.length
    ? sources.map(sourceManageRow).join('')
    : '<div class="cmp-sub">No sources yet.</div>'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">${icon('arrow-left', { size: 16 })} Home</button>
      <span class="h-title">Sources</span><span></span></div>
    <div class="cmp-sub">Shared across all presets. Editing or deleting here affects every preset.</div>
    ${html}
    <button class="save-btn sm" data-action="new-source">${icon('plus', { size: 14 })} New source</button>
  `
}

// preset への source 追加 (既存プールから / 新規作成)。
export function renderAddSource(): string {
  const available = ctx.config.sources.filter(
    (s) => s.kind !== 'builtin' && !isSourceEnabled(ctx.config, s.id),
  )
  const list = available.length
    ? available.map(sourceAddRow).join('')
    : '<div class="cmp-sub">All sources are already in this preset.</div>'
  return `
    <div class="topbar"><button class="nav-btn" data-action="home">${icon('arrow-left', { size: 16 })} Home</button>
      <span class="h-title">Add source</span><span></span></div>
    <div class="cmp-label">Existing sources</div>
    ${list}
    <div class="cmp-label">New</div>
    <button class="save-btn sm" data-action="create-new-source">${icon('plus', { size: 14 })} Create new source</button>
  `
}

// ── ソース編集 ──
function renderDetected(): string {
  const m = ctx.editMachine
  if (!m) return ''
  return `<div class="field"><label>Machine name</label><div class="autoval">${esc(m.label)}</div></div>
     <div class="field"><label>machineId</label><div class="autoval mono">${esc(m.machineId)}</div></div>`
}

function renderTestStatus(): string {
  if (ctx.testState === 'testing')
    return `<div class="status-testing">${icon('loader', { size: 14, cls: 'ic-spin' })} Connecting…</div>`
  if (ctx.testState === 'ok')
    return `<div class="status-ok">${icon('check', { size: 14 })} Connected</div>${renderDetected()}`
  if (ctx.testState === 'error')
    return `<div class="status-err">${icon('x', { size: 14 })} Failed: ${esc(ctx.testError)}</div>
      <div class="cmp-sub">Check the URL and that the server is running.</div>`
  return '<div class="cmp-sub">Test the connection to load items.</div>'
}

function renderRouteList(s: SourceDef | undefined): string {
  const routes = s ? sourceUrls(s) : []
  if (routes.length === 0) return ''
  const rows = routes
    .map((u, i) => {
      const mark =
        i === 0
          ? '<span class="url-primary-mark">Primary</span>'
          : `<button class="link-btn" data-action="url-primary" data-urlidx="${i}">Make primary</button>`
      return `<div class="url-row">
        <span class="url-text mono">${esc(u)}</span>
        ${mark}
        <button class="url-del" data-action="url-remove" data-urlidx="${i}" title="Remove route" aria-label="Remove route">${icon('x', { size: 14 })}</button>
      </div>`
    })
    .join('')
  return `
    <div class="field"><label>Routes (failover order)</label>
      <div class="url-list">${rows}</div>
      <span class="help-link-static">First route is tried first, the rest are failover. Remove old IPs and keep a stable name (e.g. <span class="mono">name.local</span>) so you never edit the IP when moving networks.</span>
    </div>`
}

export function renderSourceEdit(): string {
  const s = ctx.editingSourceId ? sourceById(ctx.config, ctx.editingSourceId) : undefined
  const url = ctx.testUrl || (s ? sourceUrl(s) : undefined) || 'http://127.0.0.1:8723'
  const testing = ctx.testState === 'testing'
  const backLabel =
    ctx.sourceEditBack === 'sources'
      ? 'Sources'
      : ctx.sourceEditBack === 'source-detail'
        ? 'Back'
        : 'Home'
  return `
    <div class="topbar"><button class="nav-btn" data-action="back">${icon('arrow-left', { size: 16 })} ${backLabel}</button>
      <span class="h-title">Server</span><span></span></div>
    <div class="field"><label>URL</label>
      <div class="field-row">
        <input type="text" value="${esc(url)}" placeholder="http://127.0.0.1:8723" />
        <button class="test-btn" data-action="test" ${testing ? 'disabled' : ''}>${testing ? '…' : 'Test'}</button>
      </div>
      <span class="help-link" data-action="help">Set up a local server ${icon('external-link', { size: 13 })}</span>
    </div>
    ${renderTestStatus()}
    ${renderRouteList(s)}
    <button class="danger-btn" data-action="delete-source">Delete source (all presets)</button>
  `
}
