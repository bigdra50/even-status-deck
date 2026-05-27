// provider プラグインの例 (manifest 形式 / 推奨)。
// $XDG_CONFIG_HOME/eveng2-toolbar/providers/ (既定 ~/.config/eveng2-toolbar/providers/) に
// コピーすると dev server が起動時に自動で読み込む (Vim 流 autoload)。
//
// 契約: default export で { id, group } を返す。
//   - id: 設定キー + 名前空間 (config.toml の [providers.<id>] と対応)。通常 group.id と揃える。
//   - group(ctx): Group ({ id, label, segments }) か null (利用不可なら null) を返す。
//   - ctx.options: config.toml の [providers.<id>] の中身が渡る (apiKey / interval 等)。
//   - segment は { id, label, value, percent?, reset?, defaultEnabled? }。value は整形済み文字列。
//   - percent (0-100) があればグラスに progress bar が出る。値の整形はプラグイン側の責務。
//   - トークン等は出さず集計値のみ載せる。
//
// 依存なしのプレーンオブジェクトでよい (import 不要)。bun/Node どちらでも .ts のまま読める。
// config で無効化 (enabled = false) すると、この provider は計算も送信もされない。

export default {
  id: 'example',
  group: (ctx: { options: Record<string, unknown> }) => {
    const label = typeof ctx.options.label === 'string' ? ctx.options.label : 'Example'
    const now = new Date()
    return {
      id: 'example',
      label,
      segments: [
        {
          id: 'clock',
          label: 'Now',
          value: `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`,
          defaultEnabled: true,
        },
      ],
    }
  },
}
