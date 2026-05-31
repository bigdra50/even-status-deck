# Status Deck 開発ルール

## Even Hub へのアップロード（必須）

Even Hub への再アップロード（Add build）時は、**毎回 `app.json` の `version` を bump する**。
同一 version のまま Add build しても Even Hub が「更新あり」と認識せず、実機に更新が反映されない。

- 修正・実機確認のたびに version を 1 つ上げる（例: 0.1.48 → 0.1.49）。同一 version での差し替えはしない。
- 手順:
  1. `app.json` の `version` を上げる
  2. コミット（`🔖 release: app.json を <ver> に`）
  3. `npm run pack`
  4. `node ~/.claude/skills/evenhub-upload/upload.mjs -m "<changelog>"`
- アップロードは Private build。公開は Even Hub UI で Private→Public に切り替える（スクリプトは行わない）。

## セカンドオピニオン・レビューに使う LLM

GPT-5.5 を使ってコードレビューや設計のセカンドオピニオンを得る場合は、OpenAI Codex 経由を GitHub Copilot 経由より優先する。

- 複数の GPT-5.5 アクセス手段を持っている場合の優先順位。いずれも無い環境では適用しない（このリポジトリは特定ツールのインストールを前提にしない）。
- 使用する CLI・認証・モデル設定は各自の環境に従う。
