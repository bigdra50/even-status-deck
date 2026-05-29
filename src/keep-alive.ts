// バックグラウンド (phone ロック / Even App 退避) でも WebView を suspend させないための
// keep-alive。Web Locks を「ページが閉じるまで解放しない」形で保持し、WebView の凍結を防ぐ。
//
// AudioContext オシレータ版の keep-alive は撤去した。理由:
//   - SDK 0.0.10 がホスト側ネイティブの WebView background keep-alive を持つため冗長
//     (changelog "Enhanced WebView background keep-alive capability")。
//   - 実機 bisect で白画面 (iOS WKWebView の WebContent jettison) には無関係 (無罪) と確定。
//   - gesture で resume して「実際に鳴らす」と逆に jettison を早める兆候があった。
//   - 本アプリは音を使わないので、WebAudio の native footprint を持つ意味が無い。
let releaseLock: (() => void) | null = null

export function activateKeepAlive(lockName = 'eveng2_toolbar_keep_alive'): void {
  // ページが閉じるまで解放されない lock を保持し、WebView の凍結を防ぐ。
  if (typeof navigator !== 'undefined' && navigator.locks && !releaseLock) {
    void navigator.locks.request(
      lockName,
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve
        }),
    )
  }
}

export function deactivateKeepAlive(): void {
  releaseLock?.()
  releaseLock = null
}
