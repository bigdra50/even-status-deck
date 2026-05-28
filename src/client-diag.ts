// [DIAG] 一時診断: companion(WebView)が白くなる原因の切り分け。
// 2秒ごとに dev server へ heartbeat を送り、白画面の瞬間に「JS が最後まで生きていたか」を観測する。
// 原因特定後に削除し、main.ts の `import './client-diag'` も外すこと。
//
// 読み方 (/tmp/eveng2-client-diag.log):
//   - beat が突然途絶え、直前に error/pagehide が無い → WebView レンダラ kill (OS による破棄) 濃厚。
//   - usedMB が limitMB 付近まで上昇 → JS ヒープ起因のレンダラ OOM。
//   - pagehide / freeze の直後に途絶え → ライフサイクルによる suspend/破棄。
//   - error / rejection 行 → その例外が原因。
//
// 送信先は同一オリジン相対 (dev server から配信されている前提)。
// 実機(.ehpk)計測時は Mac dev サーバーの LAN 絶対 URL に一時的に差し替える。原因特定後に削除する。
const ENDPOINT = '/__diag'

type PerfMemory = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }

let seq = 0
const startedAt = Date.now()

function send(kind: string, extra: Record<string, unknown> = {}): void {
  const mem = (performance as Performance & { memory?: PerfMemory }).memory
  const payload: Record<string, unknown> = {
    kind,
    seq: seq++,
    upMs: Date.now() - startedAt,
    vis: document.visibilityState,
    ...extra,
  }
  if (mem) {
    payload.usedMB = Math.round(mem.usedJSHeapSize / 1048576)
    payload.totalMB = Math.round(mem.totalJSHeapSize / 1048576)
    payload.limitMB = Math.round(mem.jsHeapSizeLimit / 1048576)
  }
  const body = JSON.stringify(payload)
  try {
    if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, body)
    else void fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {})
  } catch {
    /* 送信不可は無視 (診断なので欠落しても可) */
  }
}

send('start', { ua: navigator.userAgent })
setInterval(() => send('beat'), 2000)

window.addEventListener('error', (e) =>
  send('error', { msg: String(e.message), src: e.filename, line: e.lineno }),
)
window.addEventListener('unhandledrejection', (e) =>
  send('rejection', { reason: String((e as PromiseRejectionEvent).reason) }),
)
window.addEventListener('pagehide', (e) =>
  send('pagehide', { persisted: (e as PageTransitionEvent).persisted }),
)
document.addEventListener('visibilitychange', () => send('visibilitychange'))
// Page Lifecycle API (suspend/復帰)。DOM 型に無いため EventTarget 経由で登録。
;(document as EventTarget).addEventListener('freeze', () => send('freeze'))
;(document as EventTarget).addEventListener('resume', () => send('resume'))
