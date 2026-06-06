# リリース手順

配布物は `.ehpk`（Even Hub の build）。経路は 2 つ: Even Hub への Add build（実機配信）と GitHub Release（`.ehpk` の公開 DL）。

## Even Hub へ Add build する

1. `app.json` の `version` を上げる（例: 0.1.48 → 0.1.49）
2. コミットする（`🔖 release: app.json を <ver> に`）
3. `npm run pack`（`status-deck.ehpk` を生成）
4. `npm run upload -- -m "<changelog>"`（Web UI の「Upload a build → Add build」相当）

- version bump は毎回必須。同一 version のまま Add build しても Even Hub が「更新あり」と認識せず、実機に更新が反映されない。同一 version での差し替えはしない。
- 追加されるビルドは Private。公開は Even Hub UI で Private → Public に切り替える（スクリプトでは行わない）。
- 前提: `evenhub login` 済み（`~/.config/evenhub/credentials.yaml` の access_token を使用。失効時は refresh で自動更新）。API の詳細は `scripts/upload.mjs` 冒頭コメント。

## GitHub Release（tag 駆動）

| 操作 | CI（`pack.yml`）の挙動 |
|---|---|
| tag `v*` を push | `.ehpk` をビルドし GitHub Release に添付 |
| workflow_dispatch | `.ehpk` を artifact 化（retention 14 日） |

Even Hub への upload は CI では行わない（認証情報を CI に置かない）。CI の `.ehpk` を使う場合も Add build はローカルで `npm run upload`。
