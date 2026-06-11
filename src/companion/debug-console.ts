// ── デバッグコンソール (実験/検証用) ──
// 実機 (WKWebView) には devtools が無いため、console.* を捕捉して glass preview の下の
// 折りたたみパネルに出す。User/Geo/IP の各プローブで取得可否を実機検証するのに使う。
import { diagCounts } from '../diag-counters'
import { esc } from '../escape'
import { icon } from '../icons'

type DbgLevel = 'log' | 'info' | 'warn' | 'error'
type DbgEntry = { t: number; level: DbgLevel; text: string }
const dbgLogs: DbgEntry[] = []
const DBG_MAX = 500 // 保持する最大行数 (古いものから捨てる)
let dbgOpen = false // 既定は折りたたみ
let dbgFilter = ''
let dbgHooked = false

// ── デバッグコンソール本体 ──
function dbgTime(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const MAX_DBG_LINE = 2000 // 1 ログ行の最大文字数 (巨大オブジェクト/長文での DOM・stringify 肥大を防ぐ)

// console.* の可変長引数を 1 行テキストにする。Error は stack、オブジェクトは JSON。1 行上限で truncate。
function dbgFormat(args: unknown[]): string {
  const s = args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
      try {
        return JSON.stringify(a)
      } catch {
        return String(a) // 循環参照等
      }
    })
    .join(' ')
  return s.length > MAX_DBG_LINE ? `${s.slice(0, MAX_DBG_LINE)} …(+${s.length - MAX_DBG_LINE})` : s
}

function dbgPush(level: DbgLevel, text: string): void {
  const e: DbgEntry = { t: Date.now(), level, text }
  dbgLogs.push(e)
  if (dbgLogs.length > DBG_MAX) dbgLogs.splice(0, dbgLogs.length - DBG_MAX)
  appendDbgLineToDom(e)
  updateDbgCount()
}

function matchesFilter(text: string): boolean {
  return !dbgFilter || text.toLowerCase().includes(dbgFilter.toLowerCase())
}

function dbgLineHtml(e: DbgEntry): string {
  return `<div class="dbgc-line dbgc-${e.level}"><span class="dbgc-t">${dbgTime(e.t)}</span><span class="dbgc-msg">${esc(e.text)}</span></div>`
}

function dbgListInnerHtml(): string {
  const rows = dbgLogs.filter((e) => matchesFilter(e.text))
  return rows.length ? rows.map(dbgLineHtml).join('') : '<div class="cmp-sub">No logs</div>'
}

// #4 定常状態計測用の 1 行表示。save/notify/render の累積回数を出し、定常状態 (poll 安定後)
// で save が増えない事を実機で確認する (CLAUDE.md タスク参照)。
function diagLine(): string {
  const c = diagCounts()
  return `diag save:${c.save} notify:${c.notify} render:${c.render}`
}

function updateDbgCount(): void {
  const c = document.getElementById('dbg-count')
  if (c) c.textContent = String(dbgLogs.length)
}

function scrollDbgBottom(): void {
  const list = document.getElementById('dbg-list')
  if (list) list.scrollTop = list.scrollHeight
}

// フィルタ変更・Clear 時にリストだけ差し替える (full render を避け、入力の focus を保つ)。
function updateDbgListDom(): void {
  const list = document.getElementById('dbg-list')
  if (!list) return
  list.innerHTML = dbgListInnerHtml()
  scrollDbgBottom()
}

// 新規 1 行を直接 append (パネルが開いている間のみ)。full render を起こさず churn を抑える。
function appendDbgLineToDom(e: DbgEntry): void {
  if (!dbgOpen) return
  const list = document.getElementById('dbg-list')
  if (!list) return
  if (!matchesFilter(e.text)) return
  if (list.firstElementChild?.classList.contains('cmp-sub')) list.innerHTML = '' // "No logs" を除去
  list.insertAdjacentHTML('beforeend', dbgLineHtml(e))
  while (list.children.length > DBG_MAX) list.firstElementChild?.remove()
  scrollDbgBottom()
}

type SelectionSnapshot = {
  prevActive: Element | null
  prevInput: HTMLInputElement | HTMLTextAreaElement | null
  inputSel: { start: number | null; end: number | null } | null
  sel: Selection | null
  ranges: Range[]
}

// execCommand フォールバック前の focus/選択範囲を保存する。
function saveSelection(): SelectionSnapshot {
  const prevActive = document.activeElement
  const prevInput =
    prevActive instanceof HTMLInputElement || prevActive instanceof HTMLTextAreaElement
      ? prevActive
      : null
  const inputSel = prevInput
    ? { start: prevInput.selectionStart, end: prevInput.selectionEnd }
    : null
  const sel = window.getSelection()
  const ranges: Range[] = sel
    ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i))
    : []
  return { prevActive, prevInput, inputSel, sel, ranges }
}

// 保存した focus/選択範囲を復元する (ta.remove の後に呼ぶ)。
function restoreSelection(snapshot: SelectionSnapshot): void {
  const { prevActive, prevInput, inputSel, sel, ranges } = snapshot
  if (sel) {
    sel.removeAllRanges()
    for (const r of ranges) sel.addRange(r)
  }
  if (prevActive instanceof HTMLElement) prevActive.focus()
  if (prevInput && inputSel && inputSel.start != null && inputSel.end != null) {
    try {
      prevInput.setSelectionRange(inputSel.start, inputSel.end)
    } catch {
      // 一部の input type は setSelectionRange 非対応 (無視)
    }
  }
}

// クリップボードへ書き込む。Clipboard API → 失敗時は textarea+execCommand にフォールバック
// (WKWebView や非セキュアコンテキストで API が使えない場合に備える)。
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // フォールバックへ
  }
  // textarea+execCommand フォールバック。select() が現在の focus/選択を奪うため、
  // 直前の active 要素・入力カーソル・document 選択範囲を保存し finally で復元する。
  // textarea 除去も finally に置き、例外時に DOM へ残らないようにする。
  const snapshot = saveSelection()
  const ta = document.createElement('textarea')
  try {
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
    restoreSelection(snapshot)
  }
}

// ボタン文言を一時的に差し替えて結果を知らせる (Copied / Failed)。
function flashBtn(btn: HTMLElement, label: string): void {
  const prev = btn.textContent ?? ''
  btn.textContent = label
  window.setTimeout(() => {
    btn.textContent = prev
  }, 1200)
}

// 表示中 (フィルタ適用後) のログをテキストでコピーする。
export async function copyDbgLogs(btn: HTMLElement | null): Promise<void> {
  const rows = dbgLogs.filter((e) => matchesFilter(e.text))
  const text = rows.map((e) => `${dbgTime(e.t)} ${e.level.toUpperCase()} ${e.text}`).join('\n')
  const ok = await writeClipboard(text)
  if (btn) flashBtn(btn, ok ? 'Copied' : 'Failed')
}

// glass preview の下に出す折りたたみコンソール。閉じている間はヘッダ 1 行のみ。
export function renderDbgConsole(): string {
  const caret = icon(dbgOpen ? 'chevron-down' : 'chevron-right', { size: 16 })
  const actions = dbgOpen
    ? `<span class="cmp-actions">
        <button class="link-btn" data-action="console-copy" title="表示中のログをコピー">Copy</button>
        <button class="link-btn" data-action="console-clear">Clear</button>
        <button class="link-btn" data-action="dbg-img-probe" title="image cell の実機検証ページを追加">Img probe</button>
      </span>`
    : ''
  const head = `<div class="cmp-label cmp-label-row">
      <button class="dbgc-toggle" data-action="console-toggle">${caret} Console <span id="dbg-count" class="dbgc-count">${dbgLogs.length}</span></button>
      ${actions}
    </div>`
  if (!dbgOpen) return head
  return `${head}
    <div class="dbgc">
      <div class="dbgc-diag">${diagLine()}</div>
      <input class="dbgc-filter" type="text" placeholder="Filter…" value="${esc(dbgFilter)}" aria-label="Filter logs" />
      <div id="dbg-list" class="dbgc-list">${dbgListInnerHtml()}</div>
    </div>`
}

// console.* を捕捉してパネルにも流す (元の console もそのまま呼ぶ)。未捕捉例外も拾う。
export function hookConsole(): void {
  if (dbgHooked) return
  dbgHooked = true
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }
  console.log = (...a: unknown[]) => {
    dbgPush('log', dbgFormat(a))
    orig.log(...a)
  }
  console.info = (...a: unknown[]) => {
    dbgPush('info', dbgFormat(a))
    orig.info(...a)
  }
  console.warn = (...a: unknown[]) => {
    dbgPush('warn', dbgFormat(a))
    orig.warn(...a)
  }
  console.error = (...a: unknown[]) => {
    dbgPush('error', dbgFormat(a))
    orig.error(...a)
  }
  window.addEventListener('error', (ev) => dbgPush('error', `[window.error] ${ev.message}`))
  window.addEventListener('unhandledrejection', (ev) =>
    dbgPush('error', `[unhandledrejection] ${dbgFormat([ev.reason])}`),
  )
}

// フィルタ入力 (live)。リストだけ差し替えて入力 focus を保つ。
export function onInput(e: Event): void {
  const t = e.target
  if (t instanceof HTMLInputElement && t.classList.contains('dbgc-filter')) {
    dbgFilter = t.value
    updateDbgListDom()
  }
}

// onClick (console-toggle) から呼ぶ薄い seam。状態は本モジュールに閉じる。
export function toggleDbgOpen(): void {
  dbgOpen = !dbgOpen
}

// onClick (console-clear) から呼ぶ薄い seam。
export function clearDbgLogs(): void {
  dbgLogs.length = 0
  updateDbgListDom()
  updateDbgCount()
}

// render 後に最新行へスクロールする (パネルが開いている間のみ)。dbgOpen を本モジュールに閉じる。
export function scrollDbgBottomIfOpen(): void {
  if (dbgOpen) scrollDbgBottom()
}
