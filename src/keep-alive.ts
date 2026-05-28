// バックグラウンド (phone ロック / Even App 退避) でも WebView を suspend させない。
// 極小音量の AudioContext オシレータ + Web Locks で生存させる。eveng2-reader /
// even-toolkit で実証済みのパターンに揃える (AudioContext は autoplay で suspended のまま=無音)。
// 注意: gesture で resume して「実際に鳴らす」と iOS WKWebView の WebContent プロセスを早く
// jettison させる兆候があったため、意図的に resume しない (動作実績のある兄弟アプリと同じ inert 運用)。
let audioCtx: AudioContext | null = null
let oscillator: OscillatorNode | null = null
let releaseLock: (() => void) | null = null

export function activateKeepAlive(lockName = 'eveng2_toolbar_keep_alive'): void {
  try {
    audioCtx = new AudioContext()
    oscillator = audioCtx.createOscillator()
    oscillator.frequency.value = 1
    const gain = audioCtx.createGain()
    gain.gain.value = 0.001 // ほぼ無音
    oscillator.connect(gain)
    gain.connect(audioCtx.destination)
    oscillator.start()
  } catch {
    /* AudioContext 不可環境 (autoplay policy 等) は無視 */
  }

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
  try {
    oscillator?.stop()
    void audioCtx?.close()
  } catch {
    /* ignore */
  }
  oscillator = null
  audioCtx = null
  releaseLock?.()
  releaseLock = null
}
