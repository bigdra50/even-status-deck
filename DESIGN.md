# 設計: eveng2-toolbar

Even G2 ツールバー風サブモニタの設計。Mac のメニューバーのように、AI ツール（Claude Code / Codex …）の利用制限などを、デフォルトは最小表示、選択で詳細表示する。

## 1. 設定の階層モデル

ユーザーが companion app でカスタマイズする設定は 3 階層。

```
Machine (このマシン)                          ← レベル1: マシン毎
  ├ id     : hostname ベース (自動生成)
  ├ label  : 表示名 (ユーザー編集可)
  └ sources: 有効化するツール (利用可能なものだけ)   ← レベル2: 内容 (ソース)
       ├ claude-code  { enabled, 並び順 }
       │    └ metrics: session / weekly / sonnet / opus / cost / msgs   ← レベル3: 表示項目 + 順序
       └ codex        { enabled, 並び順 }
            └ metrics: 5h / weekly
```

## 2. データモデル（スマホ集約・bridge.setLocalStorage に保存）

設定は 1 つの config JSON に全マシン分を `machines` マップで保持し、`bridge.setLocalStorage('toolbar.config', json)` でスマホ（Even アカウント単位）に保存する。companion でマシンを切り替えて複数マシンを 1 つのスマホで管理する。

```jsonc
{
  "version": 1,
  "activeMachine": "macbook-pro-a1b2",
  "machines": {
    "macbook-pro-a1b2": {
      "label": "MacBook Pro",
      "mode": "sideload",                 // sideload | cloud
      "url": "http://192.168.1.5:5173",   // sideload=LAN dev server / cloud=固定ドメイン
      "sourceOrder": ["claude-code", "codex"],
      "sources": {
        "claude-code": {
          "enabled": true,
          "metricOrder": ["session", "weekly", "cost"],
          "metrics": {
            "session": { "enabled": true },
            "weekly":  { "enabled": true },
            "sonnet":  { "enabled": false },
            "opus":    { "enabled": false },
            "cost":    { "enabled": true },
            "msgs":    { "enabled": false }
          }
        },
        "codex": {
          "enabled": true,
          "metricOrder": ["5h", "weekly"],
          "metrics": { "5h": { "enabled": true }, "weekly": { "enabled": true } }
        }
      }
    }
  }
}
```

- 保存場所は SDK の `setLocalStorage` のみ（ブラウザ localStorage / IndexedDB は Flutter WebView では再起動で消えるため不可、device-features 参照）。
- バックグラウンド復帰時は `setBackgroundState` / `onBackgroundRestore` で view state（現在のマシン・表示中の画面）を保持する。

## 3. マシン識別 & ツール自動検出

- データソース（dev server=sideload / backend=store）が `/api/machine` を返す:
  - `machineId`: hostname ベースの安定 ID
  - `label`: hostname（初期表示名）
  - `availableSources`: ツール検出結果（`claude` CLI 有無 / `codex` CLI 有無）
- 未インストールのツールは companion でグレーアウトし、有効化できない（自動検出）。これにより「未インストールを有効化してデータ取得エラー」を防ぐ。
- glass 表示時は接続中マシンの `machineId` で `config.machines[id]` を引き、`availableSources` ∩ `enabled` の metric を順序通り描画。

## 4. companion の画面構成（マシン中心 / design-guidelines トークン）

マシンを軸に 5 画面で構成する。

```
Home ─┬─ Machines ──→ Machine Edit (label / 接続先 / 接続テスト / 削除)
      │     ├ 行タップ = 接続切替 (active machine)
      │     └ [+ 追加] = 新規 Machine Edit
      ├─ Sources & Metrics (接続中マシンの表示設定)
      └─ Preview (接続中マシンの glass 表示)
```

| 画面 | 役割 |
|---|---|
| Home | トップ。接続中マシンを常時表示し「どのマシンか」を明示。glass mini プレビュー + 各画面への入口 |
| Machines | 登録マシン一覧。`✓`=接続中、行タップで接続切替、`[編集]`、`[+ マシンを追加]` |
| Machine Edit | 1 マシンの設定: label / 接続方式 (sideload・cloud) / 接続先 URL / 接続テスト / machineId (接続先が返す) / availableSources (自動検出) / 削除 |
| Sources & Metrics | 接続中マシンの Source/Metric トグル + 並べ替え (§1 の階層)。未検出ツールはグレーアウト |
| Preview | 接続中マシンの glass 表示 (summary + 詳細ゲージ)。ヘッダにマシン名 |

- 「Preview」は旧「Usage」を改名。役割は「設定が glass にどう出るかの確認 + 現値の確認」に限定する。rate limit の深掘り分析は公式アプリ (Claude / ChatGPT) に委ね、本アプリは glass 表示と設定に集中する。
- 接続方式: `sideload` = LAN の Mac dev server URL、`cloud` = 固定ドメイン (Cloudflare Worker 等)。Machine Edit で切替。複数マシン (複数 PC / cloud) を登録し、Machines で接続先を切り替える。
- color tokens (light/dark)、FK Grotesk Neue、4/8px グリッド。`#FEF991` は accent のみ、`#3CFA44` は glass 表示のみ (phone UI で使わない)。

## 5. glass 表示（設定駆動）

- summary（最小・デフォルト）: 有効ソース × 有効 metric を圧縮し各ソース 1 行。
- 詳細（swipe）: ソース毎に全 metric をバー表示。progress bar は `━`(filled)/`─`(empty)。
- 入力: swipe up/down = `textEvent`（scroll）、single/double click = `sysEvent`（PoC のバグ修正済み設計）。double-tap で `shutDownPageContainer(1)`（系統の戻り/終了）。
- レイアウトは `@evenrealities/pretext` でピクセル精度（line height 27px）に算出。

## 6. メトリック定義

| Source | Metric | 取得元 |
|---|---|---|
| claude-code | session (5h%/reset) | `/api/oauth/usage` `five_hour` |
| claude-code | weekly (7d%/reset) | `seven_day` |
| claude-code | sonnet | `seven_day_sonnet` |
| claude-code | opus | `seven_day_opus` |
| claude-code | cost (today) | `~/.claude/projects/**/*.jsonl` 集計 |
| claude-code | msgs (today) | 同上 |
| codex | 5h (%/reset) | `codex app-server` `account/rateLimits/read` `primary` |
| codex | weekly (%/reset) | `secondary` |

将来: Gemini、システムリソース（CPU/メモリ/バッテリー）も同じ Source/Metric 枠で追加。

## 7. データ層（sideload / store の差し替え）

| モード | データソース | CORS |
|---|---|---|
| sideload（自分用） | Mac dev server（Vite middleware + proxy） | Vite proxy で回避 |
| store（.ehpk 配布） | 固定クラウド（Cloudflare Worker proxy 等） | whitelist + CORS ヘッダ必須 |

フロントは `fetchMachine()` / `fetchMetrics(source)` のデータ取得層を抽象化し、sideload/store でこの層だけ差し替える。

## 8. 取得経路（PoC で実証済み）

- Claude: macOS keychain `Claude Code-credentials` → `GET /api/oauth/usage`（`anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<ver>`）。120s キャッシュで 429 回避。
- Codex: `codex app-server` JSON-RPC `initialize` → `initialized` → ~1.5s → `account/rateLimits/read`。`primary` が埋まるまで再取得。
- トークン/認証はデータソース（Mac/サーバー）内に留め、フロント/glass には使用率（%）だけ渡す。
