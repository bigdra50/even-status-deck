// provider プラグインの例。
// $XDG_CONFIG_HOME/eveng2-toolbar/providers/ (既定 ~/.config/eveng2-toolbar/providers/) に
// このファイルをコピーすると、dev server が起動時に自動で読み込む (Vim 流 autoload)。
//
// 契約: default export で provider 関数を返す。
//   - 戻り値は Group ({ id, label, segments }) か null (利用不可なら null)。
//   - segment は { id, label, value, percent?, reset?, defaultEnabled? }。value は整形済み文字列。
//   - percent (0-100) があればグラスに progress bar が出る。
//   - 値の整形はプラグイン側の責務、描画は client 側。トークン等は出さず集計値のみ。
//
// 依存なしのプレーンオブジェクトを返すだけでよい (import 不要)。
// bun 実行 (bun run dev) なら .ts のまま読み込める。

export default async function exampleProvider() {
  // 任意の処理 (fetch / 子プロセス / ファイル読み取り など) で値を作る。
  const now = new Date()
  return {
    id: 'example',
    label: 'Example',
    segments: [
      {
        id: 'clock',
        label: 'Now',
        value: `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`,
        defaultEnabled: true,
      },
    ],
  }
}
