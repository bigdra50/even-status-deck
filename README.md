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
# ~/.config/eveng2-toolbar/config.toml
[providers.weather]
command = "python"
args = ["${configDir}/providers/weather.py"]   # 絶対パス or ${configDir} のみ
timeoutMs = 1000
ttlMs = 30000
```

```python
#!/usr/bin/env python3
# ~/.config/eveng2-toolbar/providers/weather.py
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

### (4) JS plugin（autoload, Vim 流）

`$XDG_CONFIG_HOME/eveng2-toolbar/providers/*.{ts,mjs,js}` を置くと本体が動的 import する（既定 `~/.config/eveng2-toolbar/providers/`）。本体ランタイム（`bun run server` / dev）でのみ有効（compile 単一バイナリでは無効）。

- 契約: default export で manifest `{ id, group }`。`group(ctx)` は `Group`（`{ id, label, segments }`）か `null`。
- `ctx.options` に `config.toml` の `[providers.<id>]` が渡る（apiKey 等）。`.ts` のまま読める。
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

実例: [`eveng2-claude-usage-provider`](https://github.com/bigdra50/eveng2-claude-usage-provider)（Claude の rate-limit % を返す drop-in プラグイン。非公式 API のため本体から切り出した opt-in の別 repo。`providers/` に 1 ファイル置くだけ）。`group()` がハングしても `/api/status` を止めないよう、fetch には必ずタイムアウトを入れる。

### サーバー側 config（有効/無効・オプション）

`$XDG_CONFIG_HOME/eveng2-toolbar/config.toml`（`config.json` でも可）で、サーバーが**どの provider を計算・送信するか**を制御する。companion の表示トグル（送信はされるがグラス非表示）とは別の層。

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

## セットアップ

```bash
bun install
bun run dev      # dev server (フロント + /api を同一オリジン配信)
bun run server   # standalone サーバー (/api を 0.0.0.0:8723 で配信、起動時に LAN IP を表示)
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
| `src/config.ts` | config v4（素材 sources/groups + 表示プリセット profiles / 移行）|
| `src/glass-render.ts` | グラス描画の純粋ロジック（横断描画・行予算）|
| `src/glass.ts` | glass の bridge 配線・購読・電池・keep-alive |
| `src/companion.ts` | スマホ UI（ソース管理 + 横断 segment 設定 + プレビュー）|
| `src/status-types.ts` | プロトコル型 + `parseStatusDoc` |
| `server/` | standalone サーバー（provider 群 claude/codex/system + subprocess + bun-server + vite dev middleware）|
| `vite.config.ts` | `server/vite-plugin` を dev に挿すだけ（9 行）|

## 関連

- プロトコル: [`PROTOCOL.md`](./PROTOCOL.md)
- iPhone データ源: `bigdra50/eveng2-iphone-bridge`
- PoC: `bigdra50/eveng2-demo`
- 調査ノート: survey-any `topics/mentraos-even-g2-implementation`
