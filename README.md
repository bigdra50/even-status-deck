# Status Deck

Even Realities G2 スマートグラスに、時刻 / 電池 / 各種ステータスを HUD 表示する companion アプリ。
複数のデータソース（時刻・日付、グラスの電池、PC のシステム情報、AI ツールの利用状況など）を 1 つのグラス表示に集約し、
Mac のメニューバーのように視界の端へ最小表示する。

Even Hub SDK の WebView アプリで、companion（スマホ UI）と glass（G2 576×288, 4-bit 緑単色）描画を 1 つに含む。

## 導入

時刻 / 日付 / グラスの電池だけなら、アプリを入れて接続するだけで使える。
PC のシステム情報や AI ツールの利用状況も出したいときは、その PC でローカルサーバーを起動して接続する（任意・後述）。

1. Even Hub からインストールする。
2. companion（スマホ UI）を開く。
3. グラスを接続する。

時刻 / 日付は端末ロケールで 12/24h・日付順（M/D・D/M・Y-M-D）を自動判定する（グラス表記は英語）。
どの項目を出すか・並び順は companion で変えられる（[カスタマイズ](#カスタマイズ2-階層)）。

## ローカルサーバー（任意）

PC のシステム情報や provider を配信するローカルサーバー。アプリ本体と同じ Wi-Fi 上の PC で起動し、companion から URL で接続する（クラウドは経由しない）。

前提: サーバーを動かすマシンに [Bun](https://bun.sh)（推奨）か Node.js 18+。Claude Code / Codex の利用状況を出すなら、そのマシンに各 CLI が入っていること。

1. ローカルサーバーを起動する（`/api` を `0.0.0.0:8723` で配信し、起動時に接続用の LAN IP を表示する）。

   ```bash
   bunx even-status-deck server   # Bun
   npx even-status-deck server    # Node.js
   ```

   > npm 公開後に有効。公開前は [DEVELOPMENT.md](./DEVELOPMENT.md) の clone 手順（`bun run server`）で起動する。

2. companion（スマホ UI）の「+ サーバーを追加」に、表示された `http://<LAN-IP>:8723` を登録して Test する。
3. グラス（スマホ）とサーバーのマシンを同じ Wi-Fi に置く。サーバー稼働中だけ更新され、マシンがスリープすると止まる。

provider の管理は `bun run provider`（公開後は `bunx even-status-deck provider`）。追加・カスタマイズは下記参照。

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

アプリ本体（dev / store 配布とも）は、ユーザーが任意のデバイス（claude/codex のある Mac/PC）で起動したローカルサーバーに URL で接続する（クラウドなし）。

| ソース | 種別 | 内容 |
|---|---|---|
| builtin local | client 算出 | 時刻 / 日付 / G2 グラス電池（SDK）|
| ローカルサーバー | server | Claude(cost/msgs) / Codex(rate limit) / system(CPU/mem/battery/disk)（`server/` の標準 provider）|
| iPhone bridge | server | iPhone の電池 / 歩数 / 再生中の曲 など（別リポジトリ `eveng2-iphone-bridge`）|
| 任意 | server | プロトコルに従えば 3rd party サーバーも追加可 |

companion の「+ サーバーを追加」で URL（loopback / LAN IP）を登録し接続テストする。

### 標準 provider の取得経路（`server/providers/`）

- Claude: `~/.claude/projects/**/*.jsonl` をローカル集計し cost / msgs を算出（認証不要）。
  rate-limit %（5h/Weekly 等）は OAuth の非公式エンドポイントに依存するため標準から外し、opt-in の外部 provider に委ねた（[provider を拡張する](#provider-を拡張する) (4)）。
- Codex: `codex app-server` の JSON-RPC `account/rateLimits/read`（`initialize` → `initialized` → ~1.5s 待ち → read）。
- system: `systeminformation` で CPU / メモリ / バッテリー / ディスク（全 OS）。
- トークン/認証はサーバー内に留め、`value` には %/集計済みの値だけ載せる。

## provider を拡張する

provider は「1 ソース分の `StatusDoc`（または単一 `Group`）を供給するもの」。本体（toolbar / server）に手を入れず、4 つの搬送路で足せる。拡張点は「`StatusDoc` を返す」JSON 契約一点に集約している（公開仕様 [`PROTOCOL.md`](./PROTOCOL.md) §9）。

| 方式 | 形 | 言語 | 常駐 | 使いどころ |
|---|---|---|---|---|
| (1) builtin | 本体同梱の関数 | TS | — | claude / codex / system（標準。ユーザーは書かない）|
| (2) subprocess | config 登録の command を毎 poll 実行し stdout の JSON を読む | 任意 | 不要 | ローカル拡張の第一級。お手軽 |
| (3) 独立 HTTP server | `/api/status` を話す常駐サーバーを URL 登録 | 任意 | 要 | 常駐 source / 別マシン / 既存サービス |
| (4) JS plugin | `providers/*.{ts,mjs,js}` を autoload | JS/TS | — | 本体ランタイム時の手軽な拡張 |

どれも戻り値は `StatusDoc`（§3）。値の整形はソース責務、描画は client 責務（client はドメイン知識を持たない）。

### (1) builtin（標準同梱）

本体同梱の provider。`server/providers/{claude,codex,system}.ts` が該当し、claude(cost/msgs) / codex(rate limit) / system(CPU/mem/battery/disk) を返す。ユーザーが書くものではないが、(2)(3) を書くときの実装見本になる。

### (2) subprocess provider（推奨・第一級）

`config.toml` に `command` を明示登録すると、server が**毎 poll でそのコマンドを実行し、標準出力の `StatusDoc`（または単一 `Group`）JSON を 1 ソースとして取り込む**。任意言語で書ける（`command` 指定なので shebang / Windows PATHEXT に依存しない）。常駐不要。

```toml
# ~/.config/status-deck/config.toml
[providers.weather]
command = "python"
args = ["${configDir}/providers/weather.py"]   # 絶対パス or ${configDir} のみ
timeoutMs = 1000
ttlMs = 30000
```

```python
#!/usr/bin/env python3
# ~/.config/status-deck/providers/weather.py
import json
print(json.dumps({
  "id": "weather", "label": "Weather",
  "segments": [{"id": "temp", "label": "", "value": "21°", "defaultEnabled": True}]
}))
```

これだけで glass に "Weather 21°" が出る。標準 provider と同じ `StatusDoc` を返すので、標準実装がそのまま他言語のコピペ見本になる。例: [`examples/subprocess-provider.example.py`](./examples/subprocess-provider.example.py)。

セキュリティ（`server/subprocess.ts`）— 任意コード実行になりうるため:

| 制約 | 理由 |
|---|---|
| config に**明示登録**したものだけ実行（`providers/` 自動発見・即実行はしない）| 置いただけのファイルを勝手に実行させない |
| `${configDir}` のみ展開、**絶対パス必須**（`~`/`$VAR` は展開しない、未知 token は全拒否）| shell 非経由 spawn での誤展開・相対パス注入を防ぐ |
| `shell:false` / `timeout` + 出力 512KB 上限で kill | injection・暴走・巨大出力を断つ |
| 子プロセスの env は `PATH` のみ（token / API key を渡さない）| 認証情報を拡張に漏らさない |
| 受信は `parseStatusDoc()` でサニタイズ | 不正値で描画 / DOM を壊さない |

### (3) 独立 HTTP server（常駐 source）

`/api/status` と `/api/machine`（§2）を話す常駐サーバーを自分で立て、companion の「+ サーバーを追加」に URL を登録する。(2) との違いは「立ち上げっぱなしの HTTP サーバー」である点。常駐させたい・別マシンに置きたい・既存サービスに生やしたいときに向く。

例: iPhone bridge（`eveng2-iphone-bridge`、別マシン/常駐の source）。Claude の rate-limit % のように本体と同一マシンで「API を叩くだけ」のものは (4) JS plugin の方が軽い。

### (4) JS plugin（autoload）

`$XDG_CONFIG_HOME/status-deck/providers/<id>.{ts,mjs,js}`（既定 `~/.config/status-deck/providers/`）に置き、`config.toml` に `[providers.<id>]` を書くと有効になる。本体ランタイム実行（`bunx` / `npx` / `bun run server`）で有効（autoload はバンドル配布でも効く）。`npx`（Node.js）で動かすときはプラグインを `.mjs` / `.js` で書く（`.ts` は Bun 実行時のみ読める）。

**置くだけでは動かない（gate）**: セキュリティのため、`config.toml` に `[providers.<id>]` で**明示登録した id の `<id>.<ext>` だけ**が import・実行される。未登録ファイルは import すらされない（sync ツールや誤って置いたファイルが勝手に走らない）。よって **ファイル名は id に一致**させる。`enabled = false` にすると import もしない。

- 契約: default export で manifest `{ id, group }`。`group(ctx)` は `Group`（`{ id, label, segments }`）か `null`。
- `ctx.options` に `config.toml` の `[providers.<id>]` が渡る（apiKey 等）。`.ts` のまま読める。
- 例: [`examples/provider.example.ts`](./examples/provider.example.ts)（`<id>.ts` にリネームして置く）。

```ts
// ~/.config/status-deck/providers/weather.ts
export default {
  id: 'weather',
  group: async (ctx) => {
    const t = await getTemp(ctx.options.apiKey)
    return { id: 'weather', label: 'Weather', segments: [{ id: 'temp', label: 'Temp', value: `${t}C`, defaultEnabled: true }] }
  },
}
```

```toml
# config.toml — これで初めて有効になる (gate)
[providers.weather]
apiKey = "xxxx"
```

実例: [`even-claude-usage-provider`](https://github.com/bigdra50/even-claude-usage-provider)（Claude の rate-limit % を返す drop-in プラグイン。非公式 API のため本体から切り出した opt-in の別 repo。リスクは各 provider の README で開示）。`provider install <url>`（下記 CLI）で入れるか、手動なら `providers/claude-limits.mjs` に置き `[providers.claude-limits]` を登録する。`group()` がハングしても `/api/status` を止めないよう、fetch には必ずタイムアウトを入れる。

### サーバー側 config（有効/無効・オプション）

`$XDG_CONFIG_HOME/status-deck/config.toml`（`config.json` でも可）で、サーバーが**どの provider を計算・送信するか**を制御する。companion の表示トグル（送信はされるがグラス非表示）とは別の層。

- `enabled = false` → その provider は**計算も送信もしない**（重い codex を止める / privacy）。
- subprocess (2) は `command` を書いた時点で有効。
- 既定はすべて有効。毎 poll 再読込なので**再起動なし**で反映。例: [`examples/config.example.toml`](./examples/config.example.toml)。

```toml
[providers.codex]
enabled = false        # codex を止める

[providers.weather]    # (4) plugin にオプションを渡す
enabled = true
apiKey = "xxxx"        # group(ctx) で ctx.options.apiKey として受け取る
```

### provider CLI（管理）

provider の管理は `status-deck` バイナリの **`provider` サブコマンド**（`claude mcp` / `git remote` と同じ構造。単独 install するものではない）。

```
bunx even-status-deck provider <cmd>   # 公開後: install 不要でそのまま実行 (Bun)
npx even-status-deck provider <cmd>    # 同上 (Node.js)
bun run provider <cmd>               # clone 実行の近道 (= bun server/index.ts provider <cmd>)
```

config / ledger を書き換えるだけなので、**実行中サーバーの次 poll（最大 3s）で反映、restart 不要**。

| コマンド | 説明 |
|---|---|
| `list` | 全 provider を kind / status / managed / name で一覧。`drift`（手動改変）や未登録ファイルも表示 |
| `enable <id>` / `disable <id>` | 有効/無効を切り替え |
| `install <https-url\|abs-path>` | **JS plugin** をインストール（引数1つ。**コードを実行せず**静的検証 → sha256 → atomic 配置 → 登録。id/name 等は manifest 由来）|
| `install <id> <command> [--timeout ms] [--ttl ms] [-- args...]` | **subprocess** を登録（引数2つ以上。command は bare/絶対パス）|
| `update <id>` / `update --all` | managed provider を更新（sha 比較）|
| `remove <id> [--keep-file]` | 削除（config → file → ledger）|
| `check-updates [<id>]` | 更新有無を確認（DL せず ETag / sha 比較）|

`install` は**引数の数で JS / subprocess を判別**する（JS は id が manifest 由来なので 1 つ、subprocess は id を明示するので 2 つ以上）。共通フラグ: `[--force]`。

リスク（非公式 API 利用等）は本体に承認ゲートを持たず、各 provider の README での開示に委ねる。CLI 経由でインストールしたものは managed として ledger（`$XDG_STATE_HOME/status-deck/provider-ledger.json`）に記録され、`name`/`description`/`author` のキャッシュ・update / drift 検知の対象になる。

```bash
# 例: claude-limits プラグイン (rate-limit %、非公式 API。リスクは provider の README 参照) をインストール
bunx even-status-deck provider install \
  https://raw.githubusercontent.com/bigdra50/even-claude-usage-provider/main/provider.mjs
bunx even-status-deck provider list
```

#### 手動配置からの移行（gate）

gate 導入後、`providers/` にファイルを置くだけでは動かない（未登録ファイルは import すらされない）。以前から手動配置していたものは登録する:

```bash
bunx even-status-deck provider list        # 未登録は "unregistered" として表示
bunx even-status-deck provider enable <id> # [providers.<id>] を登録して有効化 (ファイル名=id にしておく)
```

## プロトコル

公開仕様は [`PROTOCOL.md`](./PROTOCOL.md)。
ソースは `GET /api/status`（`StatusDoc`）と `GET /api/machine` を返す。`POST /api/action` は将来用に予約（stable v1 では未規定、§10）。
companion は受信時に `parseStatusDoc()` で検証・サニタイズし、`value`/`label` は HTML escape する
（glass はプレーンテキストなので対象外）。

## カスタマイズ（2 階層）

| 階層 | 場所 | 変えられること |
|---|---|---|
| どの項目を出すか | 各ソース（Mac は CLI 自動検出 / iPhone はアプリのトグル）| provider の有無 |
| グラスにどう見せるか | companion | segment ごとの ON/OFF・ドラッグ並べ替え・group 折りたたみ・HUD ヒント表示 |

設定は SDK の `setLocalStorage` に永続化する（ブラウザ localStorage は WebView 再起動で消えるため）。
ソースは登録時生成の不変 ID でキーし、URL 変更でも設定が孤児化しない。

## overlay / 通知

ステータス表示とは別に、source から一過性の overlay（通知 / トースト / バナー / ダイアログ）をグラスへ push できる（[`PROTOCOL.md`](./PROTOCOL.md) §11）。いずれもローカルサーバー稼働中・同一 Wi-Fi が前提。

- **Mac 通知の転送**: `npm run watch:mac`（= `bun run server watch mac-notifications`）で watcher を起動すると、Mac のネイティブ通知をグラスへ転送する。
  通知センターの DB を読むため、watcher を動かすプロセス（ターミナル / bun）に **Full Disk Access** が要る（System Settings > Privacy & Security > Full Disk Access に追加）。
- **はい / いいえ等のダイアログ往復**: `bun run server ask "<質問>" [選択肢...]` でグラスに modal を出し、ユーザーの選択を CLI に返す。選択肢を省くと `はい` / `いいえ`。

```bash
bun run server ask "本番にデプロイ?" はい いいえ
bun run server ask --title 確認 --timeout 30000 "削除しますか?" キャンセル 削除
```

watcher / ask はどちらもサーバーの loopback `/api/emit` に投げるので、ローカルサーバーを起動した状態で実行する。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| 前面で数分後にグラスが白画面になる | 既知問題（iOS WKWebView の WebContent 強制終了でホスト側起因）。companion を開き直すと復帰する |
| `watch:mac` で通知 DB を読めない | watcher プロセスに Full Disk Access を付与（System Settings > Privacy & Security > Full Disk Access）|
| ローカルサーバーに繋がらない | グラス（スマホ）とサーバーのマシンが同じ Wi-Fi か、URL が `http://<LAN-IP>:8723` か、サーバーが起動中かを確認 |

## ドキュメント

| 文書 | 内容 |
|---|---|
| [DEVELOPMENT.md](./DEVELOPMENT.md) | clone して動かす・テスト/CI・実機への載せ方・コード構成 |
| [RELEASE.md](./RELEASE.md) | リリース手順（version bump / Even Hub Add build / GitHub Release）|
| [DESIGN.md](./DESIGN.md) | 設計（データモデル・プリセット・取得経路・ロードマップ）|
| [PROTOCOL.md](./PROTOCOL.md) | status protocol 公開仕様（provider 実装者向け）|

## 関連

- iPhone データ源: `bigdra50/eveng2-iphone-bridge`
- PoC: `bigdra50/eveng2-demo`
- 調査ノート: survey-any `topics/mentraos-even-g2-implementation`
