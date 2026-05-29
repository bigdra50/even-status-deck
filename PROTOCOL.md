# eveng2 status protocol

Even G2 toolbar が複数のデータソースから取り込み、グラスに描画するための公開仕様。
データソース (Mac dev server / iPhone bridge / cloud / サードパーティ) はこの仕様に従って
HTTP で segment を提供する。companion (toolbar) は複数ソースを集約し、ユーザーが表示を
カスタムする。

- 現行バージョン: **1** (公開・安定)
- トランスポート: HTTP/1.1 (loopback `127.0.0.1` / LAN / cloud いずれも可)
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
{ "machineId": "iphone-local", "label": "iPhone" }
```

### `POST /api/action` (任意)

グラス操作などからの制御。本文 `{ "id": "music.next" }`。未対応ソースは 404 で良い。

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

### Segment

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ✓ | group 内で一意。 |
| `label` | string | ✓ | 表示名。**空文字なら値のみ描画** (HUD の時刻等)。 |
| `value` | string | ✓ | 表示文字列。**ソース側で整形済み** (`13%` / `$1796` / `n/a`)。client は解釈しない。 |
| `percent` | number | | 0–100。あれば progress bar を描く。 |
| `reset` | string | | 副次表示 (例 reset 残り `2h13m`)。 |
| `defaultEnabled` | boolean | | 初回の既定 ON/OFF。未指定は true。 |

設計原則: **値の整形はソース責務、描画 (bar 幅・配置・並び) は client 責務**。client はドメイン知識を持たない。

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
- 未知の追加フィールドは無視 (前方互換)。`version > 対応版` は「一部のみ解釈」または無視して良い。
- 取得失敗・タイムアウト・検証失敗のソースは **直近成功値を stale 表示**する (group を即欠落させない。
  順序と詳細ビューの揺れを防ぐ)。online / lastError は runtime 状態として持ち、永続化しない。
- リクエストには timeout と abort を付け、URL 変更前の遅延応答が後の状態を上書きしないよう
  revision (世代番号) で破棄する。

## 7. セキュリティ

- 認証情報 (OAuth トークン等) はソース内に留め、`value` には %/集計済みの値だけ載せる。
- **`value` / `label` は untrusted 文字列として扱う**。companion は HTML 描画前に必ず escape する
  (公開プロトコルで 3rd party ソースを受け入れるため)。ソースは markup を埋め込まない。
  ※ グラス描画はプレーンテキスト (LVGL container) なので XSS 経路にならないが、companion の
  プレビュー UI は DOM なので escape 必須。
- loopback / LAN 利用が主。CORS ヘッダ付与を **推奨**するが必須ではない (EvenApp WebView は実測で
  ランタイム CORS 強制をしておらず、private 配布で localhost 直結が動作する)。cloud 配信で
  ブラウザ厳格 CORS 下に置く場合のみ CORS ヘッダが必須。loopback は例外扱い。

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
| (b) 独立 HTTP server | §2 のエンドポイントを話す常駐サーバーを URL 登録 | 任意 | 常駐 source / cloud 配信時 |
| (a) JS plugin | `providers/*.mjs` を動的 import（`export default {id,group}`） | TS/JS | 上級者向け（Node/bun ランタイム時のみ） |

### (c) subprocess provider の登録（推奨・第一級）

`providers/` への自動発見・即実行はしない（任意コード実行のため）。config に command を明示登録する:

```toml
[providers.weather]
command = "python"
args = ["~/.config/eveng2-toolbar/providers/weather.py"]
timeoutMs = 1000
ttlMs = 30000
```

- provider は stdout に StatusDoc（または単一 Group）の JSON を print して exit するだけ。言語非依存（`command` 指定なので shebang / Windows PATHEXT に依存しない）。
- 受信は `parseStatusDoc()`（§6）でサニタイズ。spawn は timeout + kill、結果は `ttlMs` キャッシュ、同時実行は抑止、出力サイズ上限あり。
- 子プロセスの env は最小 allowlist（token / API key を渡さない）。`ctx.options`（`[providers.<id>]`）は限定的に env/argv で渡す。
- 標準 provider をこの形式で書けば、そのまま他言語ユーザーのコピペサンプルになる（JS の `export default` 形式と違い翻訳不要）。
- v1 は単発モード（毎 poll spawn → stdout 全体を `JSON.parse`）。高頻度向けの NDJSON 常駐モードは必要が出たら追加。

### セキュリティ

- provider は信頼コードのみ実行（config 明示登録 = ユーザーの意図）。
- token / refreshToken を provider・レスポンス・ログに出さない（§7）。サーバー内に留め `value` には集計済みの値だけ載せる。
