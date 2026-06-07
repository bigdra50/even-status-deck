# Status Deck 開発ルール

## ドキュメント構成（正本の場所）

| 文書 | 正本として持つ内容 |
|---|---|
| [README.md](./README.md) | ユーザー向け: 導入・仕組み・データソース・provider 拡張・カスタマイズ |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | clone して動かす手順・テスト/CI・実機への載せ方・ファイル役割表 |
| [RELEASE.md](./RELEASE.md) | リリース手順（version bump / Even Hub Add build / GitHub Release）|
| [DESIGN.md](./DESIGN.md) | 設計判断（データモデル・プリセット・取得経路・バックグラウンド制約）|
| [PROTOCOL.md](./PROTOCOL.md) | status protocol 公開仕様 |

同じ情報を複数文書に複製しない。迷ったら上の表の正本に書き、他からは参照する。
作業中の設計メモ・running note は git 管理しない（local scratch。公開価値が出たものは Issue / PR 本文へ昇格）。

## Even Hub へのアップロード（必須）

Even Hub への再アップロード（Add build）時は、**毎回 `app.json` の `version` を bump する**。
同一 version のまま Add build しても実機に更新が反映されない。手順の詳細は [RELEASE.md](./RELEASE.md)。

## 変更時の罠（必須）

### CONFIG_VERSION を安易に bump しない

config への additive な変更（フィールド追加・正規化）で `CONFIG_VERSION`（`src/config/constants.ts`）を bump しない。
`migrate()`（`src/config/migration.ts`）は既知 version 以外を旧形式とみなして `migrateLegacyToV5` に落とすため、素朴に bump すると保存済み config（sources/groups/view/profiles）を全消失する。
テスト/CI では捕まらず実機で起きる。
フィールド追加は同バージョン分岐（`migrateV5Same`）に足す。
bump は非互換変更のときだけ行い、そのとき旧 version 用の移行分岐を必ず追加する。

### ソースに生の NUL バイトを書かない

合成キー・dedupe キーの区切りに NUL（U+0000）を使う箇所（`src/display-identity.ts` / `src/glass-render.ts` / `src/config/normalize.ts`）は、必ず `\u0000` のエスケープ表記で書く。
生の NUL が 1 バイト入ると git がそのファイルを binary 判定し、diff / PR レビューがファイル全体で機能しなくなる（過去に config.ts と events.ts で発生）。
lint では検出されない。

### id 文字列は実コードで裏取りする

taxonomy（`src/taxonomy.ts` の `groupId|segId` キー）や provider id の引きは、不一致時に `?? 'custom'` 等の fallback へ黙って落ちる（`src/visibility/display.ts` / `server/config.ts` / `server/events.ts` も同型）。
id 文字列を書くとき・委譲で書かせるときは、必ず実コードで裏取りする。
綴り違いは例外もテスト失敗も出さず静かに壊れる。
テストも実在 id で書く（架空 id はバグを温存する）。

### 外部ホストへの fetch は app.json の network whitelist に追加する

新しい外部 API ホストへ fetch する機能を足したら、`app.json` の `permissions` network whitelist へ origin を追加する（相手 API 側の CORS 許可も別途必要）。
whitelist に無いホストへの外部 fetch はブロックされ、症状から原因が分かりにくい。
`evenhub pack` は空 whitelist の network permission を拒否する。
LAN / localhost 直結が whitelist 無しで通るのは例外（[DEVELOPMENT.md](./DEVELOPMENT.md) の実測記述）。

## 開発ワークフロー（必須）

### companion UI/IA を変えたらコミット前にローカル e2e

companion の UI/IA（Home 構造・source カード・swipe・group/segment 編集・glass layout）を変更したら、コミット / Add build / PR の前に `bun run test:e2e` をローカルで回す。
デフォルト CI gate（`ci.yml`）に e2e は無く、`e2e.yml` が別 workflow で回るだけなので、ローカルで回さないと push 後に初めて壊れに気づく。

### 機能撤去時は knip + rg で残骸スイープ

撤去した機能だけが使っていた util の連鎖 orphan を `knip` で確認する。
ただし `knip.json` はテスト（`**/*.test.ts` / `e2e/**/*.spec.ts`）を entry 扱いするため、テストからしか参照されない orphan は検出されない。
最後に `rg` で全リポジトリの残骸スイープを行う。
撤去機能の定数でも legacy 移行（`migrateLegacyToV5`）が参照するものは消さない（旧 config の移行が壊れる）。

### ブランチを切る / PR を作る前に base 同期を確認

remote は旧名 `bigdra50/eveng2-toolbar` のまま（実体は `even-status-deck` への redirect）で、前セッションの未 push コミットがローカル main に残りやすい。
feature ブランチを切る前に `git fetch origin` し、`git log --oneline origin/main..main` でローカル先行を確認する。
先行コミットがあれば先に push してから切る。
PR 作成直後に `gh pr diff <N> --name-only` で意図したファイルだけか確認する（過去に別作業が squash に巻き込まれた）。

## セカンドオピニオン・レビューに使う LLM

GPT-5.5 を使ってコードレビューや設計のセカンドオピニオンを得る場合は、OpenAI Codex 経由を GitHub Copilot 経由より優先する。

- 複数の GPT-5.5 アクセス手段を持っている場合の優先順位。いずれも無い環境では適用しない（このリポジトリは特定ツールのインストールを前提にしない）。
- 使用する CLI・認証・モデル設定は各自の環境に従う。
