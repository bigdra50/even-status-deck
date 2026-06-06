import { ensureDefaultServer, loadConfig, saveConfig } from '../config'
import { setSourcesFromConfig, startPolling, subscribe } from '../store'
import { onClick } from './actions'
import { onChange } from './conditions-ui'
import { hookConsole, onInput, scrollDbgBottomIfOpen } from './debug-console'
import {
  applySwipeOpen,
  attachSortables,
  onSwipeEnd,
  onSwipeMove,
  onSwipeStart,
} from './glass-edit'
import { registerPreviewUpdater, registerRenderer, requestRender } from './render-port'
import { ctx } from './state'
import {
  applyDisplayLabels,
  glassPreviewHtml,
  recomputeSuggestion,
  syncAll,
  visibleSig,
} from './sync'
import {
  renderAddSource,
  renderHome,
  renderSourceDetail,
  renderSourceEdit,
  renderSources,
} from './views'

// companion の共有可変状態は state.ts の ctx に集約した (分割モジュール間の共有点)。

// 表示項目リストの構成シグネチャ (順序込み)。変化したら項目リストを再描画する。
let lastVisibleSig = ''

// 現在 view に対応する画面 HTML を返す。
function screenHtml(): string {
  return ctx.view === 'source-edit'
    ? renderSourceEdit()
    : ctx.view === 'source-detail'
      ? renderSourceDetail()
      : ctx.view === 'sources'
        ? renderSources()
        : ctx.view === 'add-source'
          ? renderAddSource()
          : renderHome()
}

// 再描画後の Sortable 再付け・swipe 復元・dbg スクロールを順に行う。
function afterRenderWiring(): void {
  // home と source-detail は群/段の構成シグネチャを記録し、SortableJS を張る。
  // source-detail は #source-list を持たない (group 横断並べ替え=Glass Layout の責務) ので
  // group sortable は張られず、.src-metrics の segment 並べ替えのみ有効になる。
  if (ctx.view === 'home' || ctx.view === 'source-detail') {
    lastVisibleSig = visibleSig()
    attachSortables()
    if (ctx.view === 'home') applySwipeOpen() // 再描画後に開いていた swipe カードの transform を復元
    if (ctx.view === 'home') scrollDbgBottomIfOpen() // 開いていれば最新行へ
  }
}

function render(): void {
  if (!ctx.root) return
  // Home を出す直前に提案を最新化する。store の health 変化は Home 以外 (source-edit) でも
  // 起こり得る (接続テストで追加した source が即 offline になる等) が、その間の notify は
  // onStoreUpdate が握り潰すため、Home へ戻った描画時に必ず計算し直してバナーを正す。
  if (ctx.view === 'home') recomputeSuggestion()
  ctx.root.innerHTML = screenHtml()
  afterRenderWiring()
}

function updatePreview(): void {
  // 編集モードの WYSIWYG キャンバス (.wys-screen) は上書きしない (view の連結テキストのみ更新)。
  const el = ctx.root?.querySelector('.gpv-screen')
  if (el && !el.classList.contains('wys-screen')) el.innerHTML = glassPreviewHtml()
}

function onStoreUpdate(): void {
  syncAll() // 新 group を config に取り込み (永続。group の lastLabel = merge identity もここで捕捉)
  // 衝突解決 (segment owner prefix の displayLabel) を確定 (変化時のみ保存)。
  // group 見出しの衝突は永続リネームせず render-time マージ (display-identity の merge unit) で解く。
  if (applyDisplayLabels()) void saveConfig(ctx.config)
  // 構成 (status の有無で変わる) が変化したときだけ再描画。値だけの更新では再描画しない
  // (毎 poll の innerHTML churn が iOS WebContent jettison を招くため。issue #4)。
  if (ctx.view === 'home') {
    // 接続状態の変化で提案を再計算しバナーを更新する (dismiss 済みは recomputeSuggestion 内で除外)。
    const suggestionChanged = recomputeSuggestion()
    if (suggestionChanged || visibleSig() !== lastVisibleSig) requestRender()
  } else if (ctx.view === 'source-detail') {
    // 新 segment 出現等の構成変化で Source Detail を描き直す (新 IA)。
    if (visibleSig() !== lastVisibleSig) requestRender()
  }
}

export async function mountCompanion(el: HTMLElement): Promise<void> {
  // render port の実体登録は副作用 (イベント/購読) より前に置く (requestRender の空振り防止)。
  registerRenderer(render)
  registerPreviewUpdater(updatePreview)
  ctx.root = el
  hookConsole() // 早期の console も拾えるよう最初に仕込む
  el.addEventListener('click', (e) => void onClick(e))
  el.addEventListener('change', (e) => void onChange(e)) // segment 条件 / 表示オプションの select/number
  el.addEventListener('input', onInput) // デバッグコンソールのフィルタ
  // swipe-to-delete (Home source カード)。touchmove は passive:false で横スワイプ時のみ preventDefault する。
  el.addEventListener('touchstart', onSwipeStart, { passive: true })
  el.addEventListener('touchmove', onSwipeMove, { passive: false })
  el.addEventListener('touchend', onSwipeEnd, { passive: true })
  el.addEventListener('touchcancel', onSwipeEnd, { passive: true })
  subscribe(onStoreUpdate)

  ctx.config = await loadConfig()
  // OD-4: dev (ブラウザ / 同一オリジン) のみ自動登録。prod (.ehpk) は location.origin が
  // glasses 側ループバックを指し Mac に届かないため登録せず、help.html の手順で LAN IP を入力させる。
  if (import.meta.env.DEV && ensureDefaultServer(ctx.config, location.origin))
    await saveConfig(ctx.config)
  setSourcesFromConfig(ctx.config)
  startPolling()
  requestRender() // 時刻 (clock) は glass-local タイマーが所有。companion は周期再描画しない
}

// bridge 接続後: 永続 config を読み直して store に反映する。
export async function onCompanionBridgeReady(): Promise<void> {
  ctx.config = await loadConfig()
  // OD-4: 自動登録は dev のみ (prod は help.html の手順で LAN IP を入力させる)。
  if (import.meta.env.DEV && ensureDefaultServer(ctx.config, location.origin))
    await saveConfig(ctx.config)
  setSourcesFromConfig(ctx.config)
  requestRender()
}
