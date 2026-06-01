// provider プラグインの例 (manifest 形式 / 推奨)。
// $XDG_CONFIG_HOME/status-deck/providers/ (既定 ~/.config/status-deck/providers/) に
// コピーすると dev server が起動時に自動で読み込む (Vim 流 autoload)。
//
// 契約: default export で { id, group, name?, description?, author?, version?, dispose? } を返す。
//   - id: 設定キー + 名前空間 (config.toml の [providers.<id>] と対応)。**ファイル名 (<id>.ts) と一致させる**。
//   - group(ctx): Group ({ id, label, segments }) か null (利用不可なら null) を返す。
//   - ctx.options: config.toml の [providers.<id>] の中身が渡る (apiKey / interval 等)。
//   - segment は { id, label, value, percent?, reset?, defaultEnabled? }。value は整形済み文字列。
//   - percent (0-100) があればグラスに progress bar が出る。値の整形はプラグイン側の責務。
//   - トークン等は出さず集計値のみ載せる。
//   - name? / description? / author? (任意): 人間向けメタ。`provider list`/UI 表示用に静的に読まれ ledger にキャッシュされる。
//   - version? (任意): 表示・update 比較用。
//   - dispose? (任意): アンロード時 (ファイル削除/登録解除) に呼ばれる。timer/socket を解放する。
//   - 非公式 API を叩く等のリスクは provider 自身の README で開示する (本体に承認ゲートは無い)。
//
// 静的に読めることが必要: `provider install` は **コードを実行せず** `export default { id: '...' }` を
// 静的解析する。`export default makeManifest()` のような動的 manifest は install では拒否される (OD-C)。
// id は文字列リテラルで直接書くこと。
//
// 依存なしのプレーンオブジェクトでよい (import 不要)。bun/Node どちらでも .ts のまま読める。
// 有効化には config.toml に [providers.<id>] が必要 (gate)。`provider enable <id>` でも可。

export default {
  id: 'example',
  // name: 'Example',                 // 表示名 (list/UI)。無ければ id が使われる
  // description: 'What this shows',   // 1行説明
  // author: 'your-handle',           // 任意・自由テキスト
  // version: '1.0.0',
  // dispose: () => { /* timer/socket を解放 */ },
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
