# eveng2 status protocol

Even G2 toolbar が複数のデータソースから取り込み、グラスに描画するための公開仕様。
データソース (Mac/PC のローカルサーバー / iPhone bridge / サードパーティ) はこの仕様に従って
HTTP で segment を提供する。companion (toolbar) は複数ソースを集約し、ユーザーが表示を
カスタムする。アプリ本体 (dev / store 配布とも) はユーザーが起動したローカルサーバーに URL で繋ぐ。

- 現行バージョン: **1** (公開・安定)
- トランスポート: HTTP/1.1 (loopback `127.0.0.1` / LAN)
- 文字コード: UTF-8 JSON
- companion 側の検証は `src/status-types.ts` の `parseStatusDoc()` が実装 (受信時に
  shape 検証 + サニタイズ。不正 group/segment は破棄、想定外フィールドは除去)。

## 1. 用語

| 用語 | 意味 |
|---|---|
| Source | データの提供元。`server` (URL で接続) または `builtin` (companion がクライアント側で算出: 時刻・G2 電池)。 |
| Group | 関連 segment の束。1 つの論理ソース (例 Claude Code、iPhone)。 |
| Segment | 表示の最小単位。ラベル + 値 (+ 任意で percent/reset)。 |

## 2. エンドポイント

### `GET /api/status` (必須)

現在値の `StatusDoc` を返す。companion がポーリングする (典型 10–60s)。

```jsonc
{
  "version": 1,
  "ts": 1779800000000,          // epoch ms
  "groups": [
    {
      "id": "claude-code",
      "label": "Claude Code",
      "segments": [
        { "id": "session", "label": "Session", "value": "13%", "percent": 13, "reset": "2h13m", "defaultEnabled": true },
        { "id": "cost",    "label": "Cost",    "value": "$1796", "defaultEnabled": true }
      ]
    }
  ]
}
```

### `GET /api/machine` (必須)

ソース識別。`machineId` は安定 ID、`label` は表示名。

```jsonc
{
  "machineId": "iphone-local",
  "label": "iPhone",
  "protocolVersion": 1   // 任意。省略時は 1 とみなす (§6)
}
```

- `protocolVersion` (任意, number): ソースが話すプロトコル版。`StatusDoc.version` と同値で良い。client の機能判定に使う。
- `capabilities` (予約): 将来の機能発見用に予約済み。stable v1 では未定義 — client/server とも依存してはならない (§10)。

### `POST /api/action` (予約)

グラス操作などからソースを制御するための endpoint。**stable v1 では予約のみで未規定** — 挙動契約は確定していない。実装・依存してはならない。方向性は §10 を参照。

## 3. スキーマ

### StatusDoc

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `version` | number | ✓ | プロトコル版。現行 1。 |
| `ts` | number | ✓ | 生成時刻 (epoch ms)。 |
| `groups` | Group[] | ✓ | グループ配列 (空可)。 |

### Group

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ✓ | ソース内で一意。`[a-z0-9-]` 推奨。 |
| `label` | string | ✓ | 表示名。 |
| `segments` | Segment[] | ✓ | segment 配列。 |
| `state` | string | | `"ok"` / `"stale"` / `"error"`。group 全体の状態。各 segment は自前の `state` が無ければこれを継承する。未指定は `ok`。 |
| `message` | string | | `state` の補助メッセージ (client の tooltip 等)。 |

### Segment

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ✓ | group 内で一意。 |
| `label` | string | ✓ | 表示名。**空文字なら値のみ描画** (HUD の時刻等)。 |
| `value` | string | ✓ | 表示文字列。**ソース側で整形済み** (`13%` / `$1796` / `n/a`)。client は解釈しない。 |
| `percent` | number | | 0–100。あれば progress bar を描く。 |
| `reset` | string | | 副次表示 (例 reset 残り `2h13m`)。 |
| `defaultEnabled` | boolean | | 初回の既定 ON/OFF。未指定は true。 |
| `state` | string | | `"ok"` / `"stale"` / `"error"`。segment 単位の状態。あれば group.state を上書きする。 |
| `message` | string | | `state` の補助メッセージ。 |

設計原則: **値の整形はソース責務、描画 (bar 幅・配置・並び) は client 責務**。client はドメイン知識を持たない。

### state の意味 (transport 鮮度との 2 軸)

`state` は「ソースは応答しているが、その値の upstream が degraded」を表す。これは §6 の transport 鮮度 (client が status doc を取得できているか) とは別軸:

| 状態 | 意味 | value の扱い |
|---|---|---|
| `ok` (既定) | 値は最新で健全 | 通常表示 |
| `stale` | ソースは生存だが値は最後の既知値 (最新ではない) | 値は表示してよい。client は古い旨を提示できる |
| `error` | upstream 取得失敗 | ソースは `value` を `n/a` 等にすべき |

優先順位: transport が offline/stale (§6) なら doc 全体を stale 扱いし、その上で `state` は補助情報。transport ok のとき segment/group の `state` を反映する。`segment.state` があればそれを優先、無ければ `group.state` を継承する。

v1 の client 振る舞い:
- 操作者向け client (companion 等) は `state != ok` を提示する (例: ソース status を degraded 表示し `message` を tooltip)。
- glass (読み取り専用 HUD) は `value` をそのまま描く。`error` 時の `value: "n/a"` が値レベルで失敗を符号化するため、glass は `state` を別途描かなくてよい。

## 4. ソース identity と名前空間 (companion 集約時)

### sourceId は companion が割り当てる不変 ID

- `sourceId` は **companion がソース登録時に生成する不変 ID** (例 UUID)。URL / hostname / machineId から導出しない (URL 編集や hostname 変更で設定が孤児化するため)。
- builtin ソースは予約 ID `builtin.local` を使う。
- group id / segment id は **そのソース内で安定** であること (provider 側の責務)。値が無い期間も id と存在を保つ (欠落で順序や詳細ビューが揺れないように)。

### 名前空間は structured key で持つ

複数ソースで group id が衝突しうるため、companion は内部的に `(sourceId, groupId)` の
構造化キーで保持する (文字列連結の delimiter 衝突を避ける):

```ts
type GroupRef = { sourceId: string; groupId: string }
groups: Record<sourceId, Record<groupId, GroupCfg>>
groupOrder: GroupRef[]
```

ソース側の StatusDoc は素の `groupId` のままで良い (名前空間付与は client 側)。

## 5. 組み込みソース (builtin)

companion は server を介さずクライアント側で算出するソースを持つ。これも同じ
StatusDoc 形で表現し、server ソースと完全に同等に扱う (設定・並べ替え・描画)。

| builtin source | group | segments |
|---|---|---|
| `local` | `hud` | `time` (label "", 値 `21:28`)、`date` (label "", 値 `Tue 26/5`)、`g2` (label "G2", 値 `100%` percent 100) |

時刻/日付は端末ロケールで 12/24h・日付順を自動判定する。

## 6. バリデーション / バージョニング / 互換性

### companion 側のバリデーション契約

- 受信した StatusDoc は **必ず検証する**: `version` が number、`groups` が配列、各 group/segment が
  必須フィールドを持つか。壊れていれば **そのソースを無視**し、直近成功値 (あれば) を保持する。
- 取得失敗・タイムアウト・検証失敗のソースは **直近成功値を stale 表示**する (group を即欠落させない。
  順序と詳細ビューの揺れを防ぐ)。online / lastError は runtime 状態として持ち、永続化しない。
- リクエストには timeout と abort を付け、URL 変更前の遅延応答が後の状態を上書きしないよう
  revision (世代番号) で破棄する。

### バージョニング規則

- **未知の追加フィールドは無視する** (前方互換)。新フィールドは optional でのみ追加し、既存フィールドの
  意味は変えない。
- `version` 欠落は **v1 とみなす**。`version > 対応版` は解釈できる範囲だけ解釈し、未対応部分は無視して良い。
- **breaking change は別 major (`version: 2`) か別 path で行う** — `version: 1` の形を後方非互換に変えない。
  client は `StatusDoc.version` / `machine.protocolVersion` で機能を判定する。

### 鮮度 / キャッシュ (任意)

ポーリング負荷 (WKWebView では電池・WebContent jettison に直結) を下げるため、ソースは HTTP 標準の
条件付き取得を **MAY** で提供してよい。

- `ETag` + 条件付き `If-None-Match` → 無変更時 `304 Not Modified` (本文なし)。
- `Cache-Control: max-age=<秒>` で最小ポーリング間隔をソースから示唆する。
- client はこれらを使えれば使い、無ければ通常の GET にフォールバックする (必須ではない)。

## 7. セキュリティ

- 認証情報 (OAuth トークン等) はソース内に留め、`value` には %/集計済みの値だけ載せる。
- **`value` / `label` は untrusted 文字列として扱う**。companion は HTML 描画前に必ず escape する
  (公開プロトコルで 3rd party ソースを受け入れるため)。ソースは markup を埋め込まない。
  ※ グラス描画はプレーンテキスト (LVGL container) なので XSS 経路にならないが、companion の
  プレビュー UI は DOM なので escape 必須。
- loopback / LAN 利用のみ。CORS ヘッダは不要 (EvenApp WebView は実測でランタイム CORS 強制をしておらず、
  store インストール版アプリ + ユーザー起動サーバーの LAN 直結も動作確認済み)。付けても害はないが必須ではない。

## 8. 実装例

- **Mac dev server**: `vite.config.ts` の provider 群 (claude/codex)。`claude`/`codex` CLI を検出して group を出す。
- **iPhone bridge**: `eveng2-iphone-bridge` (Swift + Swifter)。`127.0.0.1:8723`。battery/steps/music 等を provider 化。
- **builtin local**: companion 内で時刻・G2 電池を算出。

## 9. provider 拡張（搬送路）

provider の戻り値型は常に StatusDoc / Group（§3）。搬送路はプラガブルで、本体の実装言語に依存しない。拡張点を JSON 契約一点に集約する。

| 方式 | 形式 | 言語 | 用途 |
|---|---|---|---|
| builtin | 同梱関数が Group を返す | 本体言語 | claude / codex / system の標準 provider |
| (c) subprocess | config に明示登録した command を実行し stdout の StatusDoc JSON を読む | 任意（command 指定） | ローカル拡張の第一級。標準 provider のサンプル |
| (b) 独立 HTTP server | §2 のエンドポイントを話す常駐サーバーを URL 登録 | 任意 | 常駐 source |
| (a) JS plugin | `providers/*.mjs` を動的 import（`export default {id,group}`） | TS/JS | 上級者向け（Node/bun ランタイム時のみ） |

### (c) subprocess provider の登録（推奨・第一級）

`providers/` への自動発見・即実行はしない（任意コード実行のため）。config に command を明示登録する:

```toml
[providers.weather]
command = "python"
args = ["${configDir}/providers/weather.py"]   # 絶対パス or 既知 token のみ
timeoutMs = 1000
ttlMs = 30000
```

- provider は stdout に StatusDoc（または単一 Group）の JSON を print して exit するだけ。言語非依存（`command` 指定なので shebang / Windows PATHEXT に依存しない）。
- **パス展開はしない**。spawn は shell を介さない（`shell:false`）ため、`args` の `~` / `$VAR` / `%VAR%` は展開されない（POSIX/Windows とも）。`command`/`args` は **絶対パス**にするか、本体が置換する既知 token だけを使う:
  - `${configDir}` → 設定ディレクトリ (`$XDG_CONFIG_HOME/eveng2-toolbar` 等) の絶対パス。
  - 置換後は必ず絶対パスになること。相対パスや未知 token は拒否する。
- Windows: `command` は実行ファイル解決を本体が担う（`.cmd`/PATHEXT・loopback firewall・env 差は実装側で吸収）。パス区切りはどちらでも本体が正規化する。
- 受信は `parseStatusDoc()`（§6）でサニタイズ。spawn は timeout + kill、結果は `ttlMs` キャッシュ、同時実行は抑止、出力サイズ上限あり。
- 子プロセスの env は最小 allowlist（token / API key を渡さない）。`ctx.options`（`[providers.<id>]`）は限定的に env/argv で渡す。
- 標準 provider をこの形式で書けば、そのまま他言語ユーザーのコピペサンプルになる（JS の `export default` 形式と違い翻訳不要）。
- v1 は単発モード（毎 poll spawn → stdout 全体を `JSON.parse`）。高頻度向けの NDJSON 常駐モードは必要が出たら追加。

### (a) JS plugin の manifest と gate

`providers/<id>.{ts,mjs,js}` を動的 import する（本体ランタイム時のみ。compile バイナリでは無効）。

```ts
export default {
  id: 'weather',                 // ファイル名 <id>.<ext> と一致させる
  group: (ctx) => Group | null,  // ctx.options = config の [providers.<id>]
  risk?: ('unofficial-api' | 'terms-risk' | 'account-limitation-risk')[],
  version?: string,
  dispose?: () => void,          // アンロード時に呼ばれる（timer/socket 解放）
}
```

- **gate**: ファイルを置くだけでは実行されない。config の `[providers.<id>]` 登録（または `provider enable`）された id の `<id>.<ext>` だけが import・実行される。未登録ファイルは import しない。
- **`provider add-js <https-url|abs-path>`**: コードを**実行せず**に `export default { id }` を静的解析し、`risk` を読んで未承認なら `--accept-risk` を要求する。動的 manifest（`export default makeManifest()`）は静的に読めないため拒否する。HTTPS 強制・サイズ上限・sha256・同一 dir staging → atomic rename・ledger 記録。
- `risk` は宣言値（provider 自己申告）。client/ホストは untrusted として扱い、install/list/update で提示してユーザーに承認させる。

### セキュリティ

- provider は信頼コードのみ実行（config 明示登録 = ユーザーの意図）。
- token / refreshToken を provider・レスポンス・ログに出さない（§7）。サーバー内に留め `value` には集計済みの値だけ載せる。

## 10. Reserved（非規範・stable v1 の一部ではない）

将来 minor 版で正規化する拡張点を **予約** する。stable v1 の client/server は以下に依存してはならない。
ここに書く形は確定契約ではなく方向性のスケッチ（実装は固まるまで作らない）。

### `POST /api/action` + `machine.capabilities`（予約）

glass 入力（click / scroll / double-click / IMU はすでに `onEvenHubEvent` で受信済み）から
ソースを遠隔操作する拡張点。namespace（path + `capabilities`）だけ押さえ、挙動契約は未確定。

正規化時に詰める想定の要素（非規範）:

- 発見: `GET /api/machine` の `capabilities.actions[]`（`id` / `label` / `safety: "safe"|"unsafe"` / `confirmation`）。
- 要求: `POST /api/action` 本文 `{ id, params?, requestId }`。
- 応答: `{ ok: true }` または `{ ok: false, error: { code, message } }`。同期/非同期、結果の segment 反映は未定。
- 安全性: confirmation は **client UX の安全弁であって認証ではない**。3rd party source の action は untrusted。
  companion は `unsafe` / `confirmation:"required"` を glass ジェスチャから直接実行しない。破壊的操作は
  source 側でも認証・loopback 限定・明示設定で守る（責務分担）。

未確定な理由: gesture mapping UI も実 action UX も未着手で、request 形・params・sync/async・gesture binding を
今 normative に固定すると推測を外したまま stable v1 を縛るため。実装が出てから §2 へ昇格する。

## 11. overlay イベント（source → client、transient）

source が client へ **一過性の overlay**（通知 / トースト / バナー）を push する経路。
§2-3 の `StatusDoc`（永続状態）とは別軸: イベントは **fire-once** で、再取得しても再表示しない（client が dedupe）。
代表ユースケース = Mac ネイティブ通知をグラスへ転送する。**v1 互換の追加**（別 path・既存 `StatusDoc` を変えない）。
client は `GET /api/machine` の `capabilities.events === true` を見て対応 source だけ long-poll する。

```
provider/watcher → POST /api/emit (loopback) → server buffer → GET /api/events (long-poll) → client overlay
```

dialog（modal・往復 `onResult`）は含めない。往復が要るので §10 の `POST /api/action` 方向で扱う。

### `GET /api/events?since=<seq>&waitMs=<ms>`（long-poll）

`since` 以降のイベントを返す。pending か `reset` があれば即返し、無ければ `waitMs`（既定 25000・上限 30000）まで保留して空で返る。
client は応答後すぐ次の long-poll を張る。idle churn は ~`waitMs` に 1 回、イベント時の latency ≈ RTT。

```jsonc
{
  "version": 1,
  "sourceId": "macbook",          // 任意。machineId
  "cursor": 130,                  // 次回 since に渡す (= 最大 seq)
  "reset": false,                 // true = since が古すぎ/server 再起動。client は連続性を仮定しない
  "events": [
    {
      "seq": 124,                 // source-local 単調増加
      "ts": 1779800000000,
      "providerId": "mac-notifications",
      "id": "mac:42",             // (providerId,id) で dedupe
      "kind": "notification",     // "notification" | "toast" | "banner"
      "app": "Slack", "sender": "#general", "body": "デプロイ完了 🎉",
      "ttlMs": 20000
    }
  ]
}
```

- client は `(providerId, id)` で重複排除し、`cursor` を次の `since` にする。`reset:true` は連続性破棄の合図。
- イベントは server で `ttlMs`（既定 15000）保持。失効分は配送されない（古い通知を蒸し返さない）。

### `POST /api/emit`（loopback 限定）

イベントを投入する。**`127.0.0.1` / `::1` からのみ受理**（同一ホストの watcher に限定し通知偽装を防ぐ）。LAN からは 403。

```jsonc
// 入力 (seq/ts は server が付与)
{ "providerId": "mac-notifications", "id": "mac:42", "kind": "notification",
  "app": "Slack", "sender": "#general", "body": "...", "ttlMs": 20000 }
// 応答
{ "ok": true, "seq": 124 }                  // 受理
{ "ok": false, "reason": "duplicate" }       // 同 (providerId,id) 既出 (再送不要)
{ "ok": false, "reason": "rate" }            // providerId 単位の rate 超過
```

| kind | 必須フィールド | client overlay |
|---|---|---|
| `notification` | `app`/`sender`/`body` のいずれか | 中央カード |
| `toast` | `text` | 下端 1 行・`durationMs` で自動消去 |
| `banner` | `text` | 上 1 行常駐 |

### バリデーション / セキュリティ

- 入力は untrusted として検証・サニタイズ（`src/event-types.ts` の `parseEmitInput`）。文字列長 clip・`durationMs`/`ttlMs` clamp・kind allowlist・空通知破棄。body 上限超過は POST を弾く。
- `value`/`label` 同様、`app`/`sender`/`body`/`text` も untrusted。glass はプレーンテキストで XSS 経路にならないが、companion の DOM プレビューは escape する。token は §7 どおり source 内に留め、表示文字列だけ載せる。
- 洪水対策: `providerId` 単位 rate limit + server リングバッファ + `ttlMs`。emit は loopback 限定なので脅威は同一ホストのプロセスに限られる。
