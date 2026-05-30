# 設計: eveng2-toolbar

Even G2 ツールバー風サブモニタの設計。
Mac のメニューバーのように、AI ツール（Claude Code / Codex …）の利用制限や PC/スマホの状態を、デフォルトは最小表示、選択で詳細表示する。

本書は v4（表示プリセット）を目標設計として記述する。
実装は現在 v3（全ソース同時集約・単一構成）で、§9 の移行で破壊なく v4 へ上げる。

## 0. 現状(v3)と本設計(v4)の関係

| | v3（実装済み） | v4（本設計） |
|---|---|---|
| データモデル | 全ソースを 1 画面に同時集約 | 同左 + 表示プリセット(profile)で状況別に切替 |
| 設定単位 | グローバル単一（sources / groups / groupOrder / glassLayout 各1枚） | 素材は共有、可視性・並び・レイアウトは profile 固有 |
| ソース識別 | builtin/暗黙サーバは固定 ID、ユーザー追加は randomUUID | machineId 派生 ID + 複数経路 urls[]（旧 UUID は alias 保持） |
| マシン切替 | 無し（登録したソースは常時集約） | profile 切替（"業務 / 私用 / 両方 / 出張"） |

旧 v1/v2 にあった `machines` マップ + `activeMachine` 階層は v3 で廃止済み（`migrate()` が sources 配列へ平坦化）。
v4 は machine 単位ではなく「状況（どの場面で 10 行に何を出すか）」を単位にする。

## 1. 設計モデル: 素材とレシピ

設定を 2 層に分ける。

```
[素材 = 共有資産]                         [レシピ = profile 固有]
 sources[]   接続先の実体                  profiles[]
   ├ id / machineId / urls[]                ├ Default { enabledSourceIds, view }
   └ kind / label                           ├ 業務   { enabledSourceIds, view }
 groups{}    metric の素性                  ├ 私用   { enabledSourceIds, view }
   └ 存在 / label / format / 閾値条件        └ 出張   { enabledSourceIds, view }(一時/破棄可)
                                                      │ activeProfileId で 1 つ選択
        参照 ────────────────────────────────────────┘
                                            view = { groups可視性, groupOrder, glassLayout }
```

- 素材（`sources` / `groups`）は状況に依らず 1 つの実体。接続先や metric の素性はここに 1 度だけ持つ。
- レシピ（`profiles[].view`）は「何を出すか・どう並べるか・10 行にどう置くか」を状況ごとに持つ。
- profile を複製しても素材は共有されるため、設定ドリフト（接続先や metric 定義の食い違い）が起きない。

## 2. データモデル（v4, setLocalStorage 保存）

`bridge.setLocalStorage('toolbar.config', json)` でスマホ（Even アカウント単位）に 1 つの JSON を保存する。

```jsonc
{
  "version": 4,
  "activeProfileId": "default",

  // ── 素材（共有資産）──
  "sources": [
    { "id": "builtin.local", "kind": "builtin", "label": "Device" },
    {
      "id": "host-workmac",            // machineId 派生（§3）。旧 randomUUID は alias で保持
      "kind": "server",
      "label": "Work Mac",
      "machineId": "host-workmac",     // 同一マシン判定キー（/api/machine 由来）
      "urls": [                         // 複数経路。到達順に試行（先頭優先）
        "http://192.168.1.5:5173",     // LAN
        "http://workmac.tailnet:5173"  // VPN/Tailscale
      ]
    }
  ],
  "groups": {                           // sourceId -> groupId -> 素性（label/format/閾値は profile 非依存）
    "builtin.local": {
      "clock": { "segments": [{ "id": "datetime", "format": "HH:mm  MMM d" }] },
      "g2":    { "segments": [{ "id": "level" }, { "id": "rate" }, { "id": "eta" }] }
    },
    "host-workmac": {
      "claude-code": { "segments": [
        { "id": "session", "visibility": { "combinator": "and", "conditions": [{ "kind": "threshold", "op": "gte", "value": 50 }] } },
        { "id": "weekly" }, { "id": "cost" }
      ] },
      "codex": { "segments": [{ "id": "5h" }, { "id": "weekly" }] }
    }
  },

  // ── レシピ（profile 固有）──
  "profiles": [
    {
      "id": "default",
      "name": "Default",
      "enabledSourceIds": ["builtin.local", "host-workmac"],  // fetch/表示する source（fetch 範囲）
      "view": {
        "groups": {                      // group/segment の可視性（profile ごと）
          "builtin.local": { "clock": { "enabled": true, "segments": { "datetime": true } },
                             "g2":    { "enabled": true, "segments": { "level": true, "rate": true, "eta": false } } },
          "host-workmac":  { "claude-code": { "enabled": true, "segments": { "session": true, "weekly": true, "cost": false } },
                             "codex":       { "enabled": true, "segments": { "5h": true, "weekly": true } } }
        },
        "groupOrder": [                  // 全ソース横断の表示順（profile ごと）
          { "sourceId": "builtin.local", "groupId": "clock" },
          { "sourceId": "host-workmac",  "groupId": "claude-code" }
        ],
        "glassLayout": { "rows": [], "customLabels": {} }  // 10 行配置。未設定なら group=1 行の自動描画
      }
    },
    {
      "id": "prof_work",
      "name": "業務",
      "enabledSourceIds": ["host-workmac"],   // 私用 Mac は fetch しない（節電/privacy）
      "view": { "groups": { /* … */ }, "groupOrder": [ /* … */ ], "glassLayout": { /* … */ } }
    }
  ],

  "imu": { /* 方向検出キャリブレーション（profile 非依存のハードウェア設定）*/ }
}
```

- 保存場所は SDK の `setLocalStorage` のみ。ブラウザ localStorage / IndexedDB は Flutter WebView では再起動で消える（device-features 参照）。
- `activeProfileId` も同じ config に保存する。背景復帰時はこれを `loadConfig` で読み戻す（SDK 0.0.10 に `setBackgroundState` / `onBackgroundRestore` は無いため、それらには依存しない）。
- 素材の segment 配列は「存在・順序の基準・format・閾値条件」を持つ。profile 側の `view.groups[src][grp].segments` は `{ segId: boolean }` の可視性だけを持つ。
- `format`（clock 表示形式）と `visibility`（閾値/onChange）は metric の素性として共有に置く（MVP）。profile ごとに変えたい要望が出たら profile 側へ降ろす。

## 3. ソース識別の安定化（machineId + urls[]）

ソース追加時の接続テストで `/api/machine` から取得した `machineId`（hostname ベースの安定 ID）を `SourceDef.id` に採用する。

- 利点: 削除→同一マシン再追加、出張→帰宅などで同じ source に収束し、profile の可視性・並び・レイアウトが自動復活する。
- 複数経路 `urls[]`: 同一マシンへ LAN / VPN など別 URL で繋ぐケースを 1 ソースに束ねる。接続は到達順（先頭優先、失敗で次へ）。
- 移行: 既存の randomUUID ソースは ID を変えず、`machineId` を後から付与して alias 的に紐づける（過去の profile 参照を壊さない）。
- フォールバック: サーバが `machineId` を返さない場合は url の hash か randomUUID にする（v3 の既存挙動を温存）。
- 衝突（同一 hostname の別マシン 2 台 / hostname 変更）: `machineId + url fingerprint` で別ソース化、またはユーザー確認で disambiguate する。

`availableSources`（`claude` / `codex` CLI 検出結果）も `/api/machine` から取得し、未インストールのツールは companion でグレーアウトして有効化させない（取得エラー防止）。

## 4. プリセット（profile）の意味と切替

profile は「接続先」ではなく「状況セット」。3 ユースケースを 1 つの単位で表現する。

| ユースケース | profile での表現 |
|---|---|
| 日替わりで業務/私用マシンを切替 | `業務` / `私用` profile を手動切替（並び・レイアウトも別々に保持） |
| 業務+私用マシンを同時接続して集約 | 両 source を `enabledSourceIds` に含む profile（例 `両方`） |
| 出張で一時的に別マシン | profile を複製→一時編集→離れたら破棄、元 profile へ戻す |

- 切替は手動を正とする。勝手にレイアウトが変わるのはグラス UX で危険なため。
- 自動切替は提案型に留める（§10 Phase 4）。「業務 Mac + iPhone が見つかりました。"出張" に切り替えますか?」のように手動承認を挟む。
- `enabledSourceIds` に含まれない source は fetch しない（節電・privacy・WKWebView 負荷の軽減）。「非表示だが裏で取得」は将来の明示的な background sync 機能として別途足す。
- 切替時は再集約・重い再計算・保存を起こさない。表示フィルタと layout 解決だけで描画を差し替える（WKWebView の WebContent jettison 回避。store の毎分再集約を避ける既存方針と同じ）。

## 5. companion の画面構成（design-guidelines トークン）

Home に集約し、別画面は Source Edit と Profile 管理のみ。

```
Home (縦並び)
 ├ Profile  : プリセット選択(タブ/ドロップダウン) + 追加/複製/削除/リネーム
 ├ Sources  : 接続先リスト（● + label + URL/Last seen + preset内 ON/OFF + ⚙）  ← 実体は共通 / ON-OFF は profile 固有
 ├ 表示設定 : group をジャンル折りたたみ(既定=閉) + segment トグル + 並べ替え grip   ← active profile を編集
 └ Glass    : プレビュー（最下部、active profile の描画）
      │  Sources の「+」/ ⚙
      ▼
Source Edit : 接続先 URL（複数可） + 接続テスト + 「ローカルサーバーの設定方法」リンク
              / マシン名(hostname 自動取得) / machineId(自動) / 利用可能ツール(自動検出) / 削除
```

| 画面 | 役割 |
|---|---|
| Home | Profile 切替 + Sources 管理 + 表示設定(active profile) + プレビュー |
| Source Edit | 「+」/ ⚙ から。URL 入力（複数経路）と接続テスト。マシン名・machineId・利用可能ツールは接続先から自動取得 |

- Sources の接続先実体（URL/machineId）は全 profile 共通。各 source の ON/OFF（fetch 範囲 = `enabledSourceIds`）と表示設定（可視性・並び）は active profile 固有として編集する。OFF の source は fetch せず glass/表示設定から消え、view（並び・可視性）は保持して再 ON / preset 切替で復元する。これが「業務 preset は私用 Mac を fetch しない」を実現する。
- マシン名は接続先（`/api/machine` の hostname）を自動取得し、手動入力しない。
- 「Preview」は「設定が glass にどう出るかの確認 + 現値の確認」に限定する。rate limit の深掘り分析は公式アプリ（Claude / ChatGPT）に委ねる。
- color tokens (light/dark)、FK Grotesk Neue、4/8px グリッド。`#FEF991` は accent のみ、`#3CFA44` は glass 表示のみ（phone UI で使わない）。

## 6. glass 表示（profile 駆動）

- active profile の `view` を読んで描画する。`groupOrder` で全ソースを横断し、可視 group/segment を集約する。
- summary（最小・デフォルト）: 有効ソース × 有効 segment を圧縮し各ソース 1 行。
- 詳細（swipe）: ソース毎に全 segment をバー表示。progress bar は `━`(filled) / `─`(empty)。
- glassLayout（10 行固定スロット）があれば絶対行に配置、未設定なら group=1 行で自動描画。超過分は `+N more` に畳む（MAX_ROWS=10 = 288px / 27px line-height）。
- 切断検出: offline ソースは `getRenderableStatuses` が null に置換し、古い値（嘘）を出さない。online/stale は保持値を描画。
- 入力: swipe up/down = `textEvent`（scroll）、single/double click = `sysEvent`。double-tap で `shutDownPageContainer(1)`（戻り/終了）。
- レイアウトは `@evenrealities/pretext` でピクセル精度（line height 27px）に算出。

## 7. メトリック定義

| Source 種別 | Source | Group/Metric | 取得元 |
|---|---|---|---|
| builtin（client 算出） | Device | clock: datetime | 端末ロケール（12/24h・日付順を自動判定、glass は英語表記） |
| builtin | Device | g2: level / rate / eta | SDK 電池（充電中・不足時は rate/eta を出さない） |
| server | claude-code | cost / msgs (today) | `~/.claude/projects/**/*.jsonl` 集計 |
| server | codex | 5h (%/reset) | `codex app-server` `account/rateLimits/read` `primary` |
| server | codex | weekly (%/reset) | `secondary` |
| server | system | cpu / mem / battery / disk | `systeminformation`（全OS・依存ゼロ） |

- rate-limit %（claude-code の session/weekly/sonnet/opus）は標準 provider から除外した。OAuth/keychain 経由の非公式 `/api/oauth/usage` に依存し信頼境界・後方互換が脆いため、外部 subprocess provider（PROTOCOL §9c）として opt-in する。
- 値の整形はソース（provider）責務、描画は client 責務（status line 型）。新しい group/segment は接続後に自動検出され、各 profile の Unplaced 棚に出る（自動配置はしない）。
- 将来: Gemini、システムリソース（CPU/メモリ/バッテリー）も同じ Source/Group/Segment 枠で追加。
- provider プラグイン（`$XDG_CONFIG_HOME/eveng2-toolbar/providers/*.ts` autoload）と server 側 `config.toml` の有効/無効は素材レイヤ。companion の可視性トグルとは別の層（README 参照）。

## 8. データ層 / 取得経路

アプリ本体（dev / store `.ehpk` 配布のどちらでも）は、ユーザーが任意のデバイスで起動したローカルサーバーに URL で接続する。**クラウド経由は持たない**（不要）。

| モード | 接続先 |
|---|---|
| dev（vite） | 同一オリジン（`server/vite-plugin` の middleware が `/api/status`・`/api/machine` を提供） |
| store（`.ehpk`） | ユーザーが起動したサーバーの URL。同一デバイスなら loopback、別デバイス（claude/codex のある Mac/PC で起動し phone から繋ぐ）なら LAN IP |

- フロントは `fetchStatusFrom(url)` / `fetchMachineFrom(url)` で URL に `/api/status`・`/api/machine` を叩くだけ。dev / store でデータ層は同一（差し替え不要）。
- 典型構成: claude/codex CLI のある Mac/PC で `bun run server`（将来 `bunx`）し、Even アプリ（phone）から起動ログの LAN IP を入力して接続する。だから store では server を自動登録しない（§5 / companion OD-4）。store 配布版 + ユーザー起動サーバーの LAN 直結は実機（ストアインストール版）で動作確認済み。
- Claude（標準）: `~/.claude/projects/**/*.jsonl` をローカル集計し cost / msgs を算出する（認証不要）。rate-limit % の OAuth/keychain（`/api/oauth/usage`）経路は標準から外し、外部 subprocess provider に委ねる（§7）。
- Codex: `codex app-server` JSON-RPC `initialize` → `initialized` → ~1.5s → `account/rateLimits/read`。`primary` が埋まるまで再取得。
- トークン/認証はデータソース（Mac/PC のサーバー）内に留め、フロント/glass には集計値（cost / % 等）だけ渡す。

### overlay イベント（transient push、PROTOCOL §11）

永続状態（`/api/status` の poll）とは別に、source が一過性の overlay（通知/トースト/バナー）を push する経路を持つ。代表例 = Mac ネイティブ通知のグラス転送。設計は gpt-5.5 と確定（2026-05-30）。

- 搬送: `GET /api/events` の cursor 付き **long-poll**（`since`/`waitMs`）。SSE/WS は WKWebView の jettison/電池が未検証なので不採用。`StatusDoc` に混ぜず別 path に隔離（fire-once と永続状態の混在を避ける）。
- 取り込み: `POST /api/emit`（**loopback 限定**）。外部 watcher が同一ホストから投入する。NDJSON 常駐 provider は後付け可。
- 配送意味論: source-local 単調 `seq` + `(providerId,id)` dedupe + `ttlMs` リングバッファ。client は `since` cursor と seenId で重複排除、`reset` で連続性破棄。
- client 配線: `src/events.ts` が `capabilities.events` を広告する server source だけ long-poll し、新着を `window 'toolbar:overlay'` に流す。glass の overlay（`createOverlayManager`）が描く。glass ライフサイクルで start/stop（companion では張らない＝余計な負荷を避ける）。
- watcher: `server/watchers/mac-notifications.ts`（`bun run server watch mac-notifications`）。通知センター SQLite（usernoted）を `sqlite3`/`plutil` で読み、`/api/emit` に転送。要 Full Disk Access。OS 依存で壊れやすいので読めない行はスキップ。
- dialog 往復（はい/いいえ等の応答を source へ返す）: `kind:'dialog'` を emit すると server（`server/actions.ts`）が `requestId` を払い出して events で配送、ユーザーの選択を client が `POST /api/action`（LAN）で返し、質問した watcher は `GET /api/action-result`（loopback long-poll）で受け取る。安全性は requestId（unguessable）+ index/action 検証 + accept-once。確認/利用は `bun run server ask "<質問>" <選択...>`。設計は gpt-5.5 と確定。

## 9. ローカルサーバーのリリース整備（クロスプラットフォーム・配布・拡張）

companion が叩く `/api/status`・`/api/machine` を返すローカルサーバーを、clone 不要・ワンライナー・クロスプラットフォームで配布する設計（Claude 多角調査 + gpt-5.5 で確定、2026-05-30）。拡張の搬送路は PROTOCOL §9。

### 言語・配布

- 実装は TS のまま。**Bun compile**（`bun build --compile --target=bun-{darwin,linux,windows}-{x64,arm64}`）でランタイム不要の単一バイナリ化。本プロジェクトは Bun 製なので書き換えゼロ。
- 配布: `bunx eveng2-toolbar-server`（一次・最短）+ Bun compile 単一バイナリを GitHub Releases（`curl|sh` / `irm|iex`、便利配布）。`child_process`/systeminformation が compile 後も解決するかは実機検証する。
- Rust 不採用: 単一バイナリとネイティブ計測は Bun compile + systeminformation で代替でき、TS 資産と「任意言語で provider を書ける」拡張の汎用性を失うため。ネイティブ計測が決定的に要る箇所のみ将来 Go/Rust サイドカーへ疎結合に切り出す（YAGNI）。

### 標準 provider の境界

| provider | 標準同梱 | 備考 |
|---|---|---|
| claude-code / codex | 必須 | token をサーバー内に留める信頼境界。アプリの中核 |
| system info (CPU/mem/battery/disk) | 同梱 | OS 差は systeminformation に委譲。ただし provider 層に分離し将来 subprocess 化できる構造にする |
| 天気 / CI / 自作 | ユーザー拡張 | PROTOCOL §9 の subprocess provider / 独立 server |

### クロスプラットフォーム（macOS/Linux 同時 → Windows 後追い）

- Claude（標準 provider）: token を一切扱わず `~/.claude/projects/**/*.jsonl` のローカル集計のみ（cost / msgs）。keychain / `/api/oauth/usage` を使う rate-limit % は標準から除外し、外部 subprocess provider（PROTOCOL §9c）として opt-in する。credential file / keychain への依存は標準 server から無くなった。
- system info: 手書き `vm_stat`/`pmset`/`df`/`loadavg` を `systeminformation`（npm・依存ゼロ・全OS・wmic 廃止対応済み）へ置換。`loadavg/cores` 概算は Windows で常に 0% になるため `currentLoad()` に置換。group id は OS 非依存になったため `system`（旧 `mac`）。
- codex: `codex app-server` 自体は OS 非依存。Windows の `spawn('codex')` は `.cmd` シムで ENOENT になりうるため `process.platform==='win32'` で `shell:true` か `codex.cmd`（後追い・実機検証）。失敗しても codex セグメントが n/a になるだけでクラッシュしない。
- credential の平文ファイルには refreshToken（長命）が含まれる。**token/refreshToken はレスポンス・ログ・subprocess に出さない**（集計値 % だけ glass へ）。WSL は Windows 側ファイルの 0777 継承に注意し Linux ネイティブの `~/.claude/.credentials.json` を読む。

### 段階

- Phase 1: server を vite から切り出し + systeminformation + subprocess provider(MVP) + bunx/Bun compile + help.html。macOS/Linux 同時。（実装済み: §11 と PROTOCOL §9）
- Phase 2: Windows 対応（codex spawn）+ 必要なら NDJSON 常駐 provider。
- store 配布でもデータ源はユーザーが起動するローカルサーバーなので、subprocess provider も独立 HTTP server もそのまま使える（クラウド差し替えは廃止）。

## 10. 移行（v3 → v4 migration）

`migrate()`（`config.ts`）に v4 ステップを追加する。破壊なし。

1. 既存 v3 の `sources` / `groups` / `groupOrder` / `glassLayout` / 全ソース ON を、丸ごと `Default` profile（`id: 'default'`）の `view` + `enabledSourceIds`（全 source）へ収容する。
2. `activeProfileId = 'default'` を設定する。起動後の見た目は v3 と同一。
3. 素材を分離する: `groups[src][grp]` から表示系（enabled / segment enabled / align / showDefaultLabel）を Default profile の `view` へ移し、素材側 `groups` には segment の存在・format・visibility条件だけ残す。
4. server source に `urls`（旧 `url?` を `urls[0]` へ）と `machineId`（次回接続テストで付与）を補完する。
5. 既存の additive migration（ensureBuiltin / consolidateClock / normalizeVisibility / normalizeGlassLayout / pruneOrphans）は維持する。`pruneOrphans` は profile の `view` も対象に拡張する。

## 11. Phase ロードマップ

```
Phase 1 [MVP]  v4 データモデル + Default profile 1個（切替UIは未公開、Default固定）
                → 手戻り防止。既存の表示設定UIを active profile 編集に配線。見た目不変。
Phase 2        プリセット切替UI（companion に選択 + 追加/複製/削除/リネーム）
                → glass は activeProfileId で描画。切替は setLocalStorage 保存で背景復帰も保持。
Phase 3        source 安定化（machineId 採用 + urls[] 複数経路、旧UUIDは alias）
                → 削除→再追加 / 出張→帰宅で同一 source に収束しレイアウト自動復活。
Phase 4        接続検出ベースの提案型自動切替（自動適用はせず手動承認）
                → 「業務Mac+iPhone が見つかりました。"出張" に切替?」
```
