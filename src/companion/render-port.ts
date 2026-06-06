// render()/updatePreview() の間接参照ポート。子モジュールはこの requestRender /
// requestPreviewUpdate を呼び、index.ts が起動時 (mountCompanion 先頭) に実体を登録する。
// 子 → index の import を作らないための唯一の経路で、実行は登録された関数をそのまま
// 同期で呼ぶ (render は DOM 更新に加え Sortable 再登録・swipe 復元も行うため遅延させない)。
let renderFn: () => void = () => {}
let previewFn: () => void = () => {}

export function registerRenderer(fn: () => void): void {
  renderFn = fn
}

export function requestRender(): void {
  renderFn()
}

export function registerPreviewUpdater(fn: () => void): void {
  previewFn = fn
}

export function requestPreviewUpdate(): void {
  previewFn()
}
