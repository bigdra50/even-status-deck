# eveng2-toolbar

Even G2 のツールバー風サブモニタ。普段の PC 作業中に、Claude Code / Codex の利用制限（セッション/週次 rate limit）や開発系ステータスを、グラスの視界の端に最小表示する。Mac のメニューバーのように、デフォルトは邪魔にならない最小表示、選択すると詳細を表示する。

## 背景 / PoC

取得経路と G2 表示は PoC（`eveng2-demo`）で実証済み。

- Claude rate limit: macOS keychain の OAuth トークン → `GET https://api.anthropic.com/api/oauth/usage`
  - `five_hour.utilization` (セッション) / `seven_day.utilization` (週次) / `seven_day_sonnet` / `resets_at`
  - ヘッダ: `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<ver>`
  - 注意: 非公式エンドポイント。30-60s ポーリングは 429 になるため 120s 程度キャッシュ。
- Codex rate limit: `codex app-server` の JSON-RPC `account/rateLimits/read`
  - `primary.usedPercent` (5h) / `secondary.usedPercent` (7d) / `resetsAt` (Unix sec) / `planType`
  - シーケンス: `initialize` → `initialized` → ~1.5s 待ち → `account/rateLimits/read`
  - 注意: experimental。認証完了前に読むと `primary` が null になるので待ち時間を確保。
- 表示: Even Hub SDK の WebView アプリ → G2 (576×288, 4-bit 緑単色) に描画。
- セキュリティ: トークン/認証はサーバー（Mac dev server）内に留め、フロント/グラスには使用率（%）だけ渡す。

## 計画

| Phase | 内容 |
|---|---|
| 0 | 基盤: リポジトリ + Even スキル `everything-evenhub` で正確な SDK 情報を確保 |
| 0.5 | companion (スマホ WebView UI) / glass (G2 表示) の構成決定 |
| 1 | デザイン (HTML/CSS, Figma 代替): glass + companion の画面・遷移・状態 |
| 2 | 実装: rate limit 取得 (Claude oauth / Codex app-server) 移植 + UI |
| 3 | データ層 (sideload=Mac dev server / store=固定クラウド) + `.ehpk` 配布 |

## データ層の方針（PoC で確認済みの制約）

- sideload（自分用）: Mac dev server がフロント + API を同一オリジン配信 → whitelist/CORS 不要、PC データ直結。
- store 配布（.ehpk）: `app.json` の `network` whitelist は固定ドメイン前提 + CORS 必須。各ユーザーの LAN IP は不可 → PC データは固定クラウド中継が必要。
- フロントとデータ取得層を疎結合にし、sideload/store でデータ層だけ差し替える。

## 関連

- PoC: `bigdra50/eveng2-demo`
- 調査ノート: survey-any `topics/mentraos-even-g2-implementation`（経路 A/B/C 比較、whitelist 制約、取得経路）
