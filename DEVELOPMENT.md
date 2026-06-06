# 開発ガイド

リポジトリを clone して動かす場合（コントリビュート / npm 公開前の起動）。一般ユーザーは [README](./README.md#ローカルサーバー任意) の bunx / npx で足りる。

## セットアップ

```bash
bun install
bun run dev          # dev server (フロント + /api を同一オリジン配信)
bun run server       # standalone サーバー (/api を 0.0.0.0:8723 で配信、起動時に LAN IP を表示)
bun run provider     # provider 管理 CLI (list / enable / install / ...)。例: bun run provider list
bun run build:server # server を bunx/npx 配布用の単一 dist-server/index.js にバンドル
bun run sim          # evenhub-simulator で動作確認
bun run qr           # 接続先 URL の QR を表示 (スマホから dev-URL sideload)
bun run build        # tsc && vite build
bun run pack         # build + .ehpk 生成 (status-deck.ehpk)
bun run lint         # biome
```

## テスト / CI

```bash
bun run test:unit     # unit (bun test server src)
bun run test:coverage # unit + coverage (lcov → Codecov)
bun run test:e2e      # companion UI の playwright e2e (dev server は自動起動)
bun run test:sim      # evenhub-simulator のグラス表示 e2e (e2e-sim/run.ts)
```

コード品質ゲート（`ci.yml` の build ジョブ）:

- `lint` — Biome（`noExcessiveCognitiveComplexity` warn、閾値 15）
- `lint:deps` — dependency-cruiser
- `knip` — 未使用 export / dep
- `lint:dup` — jscpd 重複率 3% 未満
- `lint:fta` — FTA score-cap 120（src / server 共通。companion・config 分割後の worst は 83）
- `test:coverage` + Codecov — `bun test --coverage`（patch は informational）

| workflow | トリガ | 内容 |
|---|---|---|
| `ci.yml` | push main / PR | lint → lint:deps → knip → lint:dup → lint:fta → test:coverage → build |
| `e2e.yml` | push main / PR | playwright e2e |
| `sim-e2e.yml` | push main / dispatch | simulator E2E（ジョブが重いので PR では回さない） |
| `pack.yml` | tag `v*` / dispatch | `.ehpk` を artifact / Release 化（[RELEASE.md](./RELEASE.md) 参照） |
| `badges.yml` | push main / dispatch | jscpd 重複率と FTA score のバッジ JSON を badges ブランチへ push |

## 実機への載せ方

- dev-URL QR: `bun run qr` の QR を Even Hub アプリでスキャン → dev server から hot reload で読み込む（`.ehpk` 不要、同一オリジンでデータ直結）。
- `.ehpk` サイドロード / private 配布: `bun run pack` で生成し、Even Hub portal にアップロード（[RELEASE.md](./RELEASE.md)）。
  companion の Machine/ソース設定で Mac の LAN URL や iPhone bridge（`http://127.0.0.1:8723`）を登録する。
  EvenApp の WebView は実測でランタイム CORS / network whitelist を厳格強制しておらず、
  private 配布で localhost / LAN 直結が動作する。

## 構成

| ファイル | 役割 |
|---|---|
| `src/store.ts` | 共有 store（複数ソース集約・ポーリング・stale）|
| `src/builtins.ts` | builtin local（時刻/日付/電池 → StatusDoc）|
| `src/data.ts` | `fetchStatusFrom` / `fetchMachineFrom`（URL 明示・timeout/abort）|
| `src/config.ts` | config v4（素材 sources/groups + 表示プリセット profiles / 移行）|
| `src/glass-render.ts` | グラス描画の純粋ロジック（横断描画・行予算）|
| `src/glass.ts` | glass の bridge 配線・購読・電池・keep-alive |
| `src/companion/` | スマホ UI（ソース管理 + 横断 segment 設定 + プレビュー）。`index.ts`=起点/render 配線、`state.ts`=共有状態 ctx、`actions.ts`=click ハンドラ、`views.ts`/`rows.ts`=画面/行 render、`glass-edit.ts`/`fs-editor.ts`=配置エディタ、`conditions-ui.ts`=change ハンドラ、`sync.ts`=同期ヘルパ、`debug-console.ts` |
| `src/status-types.ts` | プロトコル型 + `parseStatusDoc` |
| `server/` | standalone サーバー（provider 群 claude/codex/system + subprocess + http-server + vite dev middleware）|
| `vite.config.ts` | `server/vite-plugin` を dev に挿すだけ（9 行）|

設計の背景は [DESIGN.md](./DESIGN.md)、プロトコル仕様は [PROTOCOL.md](./PROTOCOL.md)。
