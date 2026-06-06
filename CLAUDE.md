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

## セカンドオピニオン・レビューに使う LLM

GPT-5.5 を使ってコードレビューや設計のセカンドオピニオンを得る場合は、OpenAI Codex 経由を GitHub Copilot 経由より優先する。

- 複数の GPT-5.5 アクセス手段を持っている場合の優先順位。いずれも無い環境では適用しない（このリポジトリは特定ツールのインストールを前提にしない）。
- 使用する CLI・認証・モデル設定は各自の環境に従う。
