# eveng2-toolbar

Even G2 のツールバー風サブモニタ。
複数のデータソース（AI ツールの利用制限、PC / スマホの状態など）を 1 つのグラス表示に集約し、
Mac のメニューバーのように視界の端へ最小表示する。

Even Hub SDK の WebView アプリで、companion（スマホ UI）と glass（G2 576×288, 4-bit 緑単色）描画を 1 つに含む。

## 仕組み

「サーバーが決まった形式（segment）でデータを提供し、クライアントは汎用に描画する」status line 型。
複数ソースを共有 store が集約し、companion と glass が購読して描画する。

```
 共有 store (取得 1 系統)
   builtin local ── 時刻/日付/G2電池 を client 算出
   server A ──┐
   server B ──┤ 並列 fetch (per-source revision/abort, 失敗は直近成功を stale 保持)
   …        ──┘
        │ subscribe
   ┌────┴─────┐
  glass       companion
  横断描画      ソース管理 + 横断 segment 設定
```

- 表示単位は **segment**（label + value (+ percent で bar, reset)）。値の整形はソース責務、描画は client 責務。
- グラスは ~10 行。`groupOrder`（ソース横断の並び）で表示順を持ち、超過分は `+N more` に畳む。
- HUD（時刻/日付/G2 電池）も builtin local ソースの 1 group なので、並べ替え・ON/OFF できる。
- 時刻/日付は端末ロケールで 12/24h・日付順（M/D・D/M・Y-M-D）を自動判定。グラス表記は英語。

## データソース

| ソース | 種別 | 内容 |
|---|---|---|
| builtin local | client 算出 | 時刻 / 日付 / G2 グラス電池（SDK）|
| Mac dev server | server | Claude Code / Codex の rate limit（`vite.config.ts` の provider）|
| iPhone bridge | server | iPhone の電池 / 歩数 / 再生中の曲 など（別リポジトリ `eveng2-iphone-bridge`）|
| 任意 | server | プロトコルに従えば 3rd party サーバーも追加可 |

provider を足すだけで表示要素が増える。companion の「+ サーバーを追加」で URL を登録し接続テストする。

### Mac dev server の取得経路（`vite.config.ts`）

- Claude Code: macOS keychain の OAuth トークン → `GET https://api.anthropic.com/api/oauth/usage`
  （`anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<ver>`、120s キャッシュで 429 回避）。
- Codex: `codex app-server` の JSON-RPC `account/rateLimits/read`
  （`initialize` → `initialized` → ~1.5s 待ち → read）。
- トークン/認証はサーバー内に留め、`value` には %/集計済みの値だけ載せる。

## provider プラグイン（autoload, Vim 流）

アプリを改修せず、`.ts` を 1 つ置くだけで表示要素を追加できる。

- 読み込み先: `$XDG_CONFIG_HOME/eveng2-toolbar/providers/*.{ts,mjs,js}`（既定 `~/.config/eveng2-toolbar/providers/`）。
- 契約: default export で manifest `{ id, group }` を返す。`group(ctx)` は `Group`（`{ id, label, segments }`）か `null`。
- `ctx.options` に `config.toml` の `[providers.<id>]` が渡る（apiKey 等）。
- `.ts` のまま読める。ファイルを置けば次の poll から有効（編集の反映は dev server 再起動）。
- 例: [`examples/provider.example.ts`](./examples/provider.example.ts)。

```ts
// ~/.config/eveng2-toolbar/providers/weather.ts
export default {
  id: 'weather',
  group: async (ctx) => {
    const t = await getTemp(ctx.options.apiKey)
    return { id: 'weather', label: 'Weather', segments: [{ id: 'temp', label: 'Temp', value: `${t}C`, defaultEnabled: true }] }
  },
}
```

置いた group は companion が自動検出し、glass にも横断表示される（トグル・並べ替え可）。
別言語・別プロセスで足したいときは provider プラグインではなく独立 server（`/api/status` を話す source）にする。

### サーバー側 config で provider を有効/無効・設定

`$XDG_CONFIG_HOME/eveng2-toolbar/config.toml`（`config.json` でも可）で、サーバーが
**どの provider を計算・送信するか**を制御する。companion の表示トグルとは別の層:

- config で `enabled = false` → その provider は**計算も送信もしない**（重い codex を止める / privacy）。
- companion のトグル → 送信はされるがグラス非表示。
- 既定はすべて有効。毎 poll 再読込なので**再起動なし**で反映。例: [`examples/config.example.toml`](./examples/config.example.toml)。

```toml
[providers.codex]
enabled = false        # codex を止める

[providers.weather]    # プラグインにオプションを渡す
enabled = true
apiKey = "xxxx"        # group(ctx) で ctx.options.apiKey として受け取る
```

## プロトコル

公開仕様は [`PROTOCOL.md`](./PROTOCOL.md)。
ソースは `GET /api/status`（`StatusDoc`）と `GET /api/machine` を返す。`POST /api/action` は任意（制御）。
companion は受信時に `parseStatusDoc()` で検証・サニタイズし、`value`/`label` は HTML escape する
（glass はプレーンテキストなので対象外）。

## カスタマイズ（2 階層）

| 階層 | 場所 | 変えられること |
|---|---|---|
| どの項目を出すか | 各ソース（Mac は CLI 自動検出 / iPhone はアプリのトグル）| provider の有無 |
| グラスにどう見せるか | companion | segment ごとの ON/OFF・ドラッグ並べ替え・group 折りたたみ・HUD ヒント表示 |

設定は SDK の `setLocalStorage` に永続化する（ブラウザ localStorage は WebView 再起動で消えるため）。
ソースは登録時生成の不変 ID でキーし、URL 変更でも設定が孤児化しない。

## セットアップ

```bash
bun install
bun run dev      # dev server (フロント + /api を同一オリジン配信)
bun run sim      # evenhub-simulator で動作確認
bun run qr       # 接続先 URL の QR を表示 (スマホから dev-URL sideload)
bun run build    # tsc && vite build
bun run pack     # build + .ehpk 生成 (eveng2-toolbar.ehpk)
bun run lint     # biome
```

実機への載せ方:

- **dev-URL QR**: `bun run qr` の QR を Even Hub アプリでスキャン → dev server から hot reload で読み込む（`.ehpk` 不要、同一オリジンでデータ直結）。
- **`.ehpk` サイドロード / private 配布**: `bun run pack` で生成し、Even Hub portal にアップロード。
  companion の Machine/ソース設定で Mac の LAN URL や iPhone bridge（`http://127.0.0.1:8723`）を登録する。
  EvenApp の WebView は実測でランタイム CORS / network whitelist を厳格強制しておらず、
  private 配布で localhost / LAN 直結が動作する。

## バックグラウンド対応

phone ロック / Even App バックグラウンドでもグラスを生存させる（提出 QA 要件）。

- keep-alive: 極小音量の AudioContext オシレータ + Web Locks（`keep-alive.ts`）。
- ライフサイクル: `FOREGROUND_ENTER` で再取得、`ABNORMAL/SYSTEM_EXIT` で cleanup、
  root double-tap → `shutDownPageContainer(1)`（終了確認ダイアログ）。

## 構成

| ファイル | 役割 |
|---|---|
| `src/store.ts` | 共有 store（複数ソース集約・ポーリング・stale）|
| `src/builtins.ts` | builtin local（時刻/日付/電池 → StatusDoc）|
| `src/data.ts` | `fetchStatusFrom` / `fetchMachineFrom`（URL 明示・timeout/abort）|
| `src/config.ts` | config v3（sources / 横断 groupOrder / 移行）|
| `src/glass-render.ts` | グラス描画の純粋ロジック（横断描画・行予算）|
| `src/glass.ts` | glass の bridge 配線・購読・電池・keep-alive |
| `src/companion.ts` | スマホ UI（ソース管理 + 横断 segment 設定 + プレビュー）|
| `src/status-types.ts` | プロトコル型 + `parseStatusDoc` |
| `vite.config.ts` | Mac dev server の provider（claude/codex）|

## 関連

- プロトコル: [`PROTOCOL.md`](./PROTOCOL.md)
- iPhone データ源: `bigdra50/eveng2-iphone-bridge`
- PoC: `bigdra50/eveng2-demo`
- 調査ノート: survey-any `topics/mentraos-even-g2-implementation`
