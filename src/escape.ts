// HTML escape。companion はソース由来の label/value/machine.label を innerHTML に埋めるため、
// 公開プロトコルで untrusted な文字列を受け入れる前提で必ずエスケープする (XSS 防止)。
// ※ グラス描画はプレーンテキスト (LVGL) なので escape 不要。companion の DOM のみ対象。
const MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => MAP[c] ?? c)
}
