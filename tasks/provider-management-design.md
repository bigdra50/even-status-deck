# eveng2-toolbar provider 管理 — 最終設計 (install / update / uninstall)

元設計と敵対的レビュー (security / roundtrip) を統合した、実装可能な確定設計。
矛盾解消・欠陥修正・未決の確定・段階分け・OPEN DECISIONS の分離を行った。

対象プラットフォーム: macOS / Linux (Bun ランタイム)。Windows は非対応 (理由は §11)。

---

## 0. この設計が現行コードと違う点 (実装前提の明示)

レビュー C-1 を反映。現行コードはまだ gate を持たない。読者が「実装済み」と誤解しないよう明記する。

| 項目 | 現行 (`server/`) | 本設計 |
| --- | --- | --- |
| autoload gate | 無し。`providers/` に置けば全件 `import()` され実行される | config セクション or ledger 登録を必須にする (§4) |
| ledger | 無し | `$XDG_STATE_HOME/eveng2-toolbar/provider-ledger.json` を追加 (§2) |
| CLI | `eveng2-toolbar-server` 起動のみ | `provider` サブコマンド群を追加 (§1) |
| risk 宣言 | 無し | JS manifest `risk?` + subprocess `--accept-risk` (§6) |

> 重要 (C-1): Phase 1 (gate) 完了までは「`providers/` に置けば任意コードが実行される」状態が続く。
> Phase 1 完了前は `providers/` を空に保つ運用ルールを README に記す。Phase 1 の最初のタスクを gate 実装にする。

---

## 1. 未決事項の確定

### 未決1: autoload gate — 確定: 2 層 gate (ファイル配置 + 明示登録の AND)

`providers/` のファイルは「存在するだけでは有効化されない」。
有効化条件: `config.toml`/`config.json` に `[providers.<id>]` セクションがある、または ledger に該当 id が登録済み。
ledger 登録分は merge 時に `cfg.providers[id]` へ注入する (§5) ため、gate は最終的に `cfg.providers[id] !== undefined` の 1 条件で判定できる。

レビュー C-1(roundtrip)/I-6 反映:
- merge は JS kind の ledger エントリも `cfg.providers` に注入する (§5)。これで「ledger 登録あり・config セクション無し」でも gate を通り、install の Step6→7 クラッシュからもリカバリーできる。
- gate は id ではなく「ファイルパス → manifest id → `cfg.providers[id]`」で引く。同一 id を持つ複数パスの扱いは下記で確定する。

### 未決2: subprocess / managed エントリの保存先 — 確定: ledger (JSON) に保存。config.toml には書き戻さない

`smol-toml` は `stringify` を export している (検証済み) が、書き戻しはコメント・インラインコメント・セクション順序を roundtrip で保持できない (TOML 仕様上 parse でコメントは捨てられる)。
よって `config.toml` はユーザー所有の read-only、CLI が管理するエントリは ledger に分離する (MCP CLI が `~/.claude.json` を所有するのと同じ構造)。

### 未決4: reload モデル — 確定: JS は restart 必須、config/subprocess は live。`/api/reload` は追加しない

ES module キャッシュを Bun が保持するため、`loaded` Map をクリアしても古いコードが返り得る (レビュー I-4)。Worker + dynamic import で解けるが複雑度が跳ね上がるため MVP では採らない。

```
live (再起動不要):
  - config.toml の enabled/disabled
  - config.toml / ledger の subprocess command/args/ttl/timeout 変更
  - subprocess provider の追加 (ledger 書き込み → 次 poll で反映)
restart 必須:
  - JS plugin (providers/*.{ts,mjs,js}) の追加・更新・削除
```

`provider reload` は MVP では「手動で再起動してください」を表示するだけ (§11 の SIGUSR2 は将来)。

### 未決5: risk 宣言源 — 確定: JS は manifest `risk?`、subprocess は `--accept-risk` フラグ

install/update 時に承認済みタグを ledger の `acceptedRisks` に記録する (§6)。

---

## 2. Ledger — スキーマと置き場所

### 置き場所

```
$XDG_STATE_HOME/eveng2-toolbar/provider-ledger.json
(未設定時: ~/.local/state/eveng2-toolbar/provider-ledger.json)
```

理由: ledger は「ツールが管理する状態の記録」。ユーザー手動編集対象でも再生成可能キャッシュでもないため STATE が適切。

### スキーマ (TypeScript)

レビュー I-5 反映: `env` フィールドは持たない (credential 平文記録を排除)。

```typescript
export type RiskTag = 'unofficial-api' | 'terms-risk' | 'account-limitation-risk'

export type LedgerEntryJs = {
  id: string
  kind: 'js'
  managed: true
  source: string                 // "https://..." or "local:<absolutePath>"
  installedSha256: string        // providers/<id>.<ext> の SHA256 (必須)
  etag: string | null            // HEAD で取れた ETag。なければ null
  installedVersion: string | null
  installedAt: string            // ISO8601
  risk: RiskTag[]
  acceptedRisks: RiskTag[]
  enabled: boolean
  ext: 'ts' | 'mjs' | 'js'       // 実ファイル拡張子 (remove/drift で使う)
}

export type LedgerEntrySubprocess = {
  id: string
  kind: 'subprocess'
  managed: true
  source: string                 // "command:<command>"
  command: string                // bare(PATH) か絶対パス。cwd 相対は拒否 (I-3 改: subprocess.ts と整合)
  args: string[]
  timeoutMs: number
  ttlMs: number
  installedSha256: string | null // command を読めれば SHA256、不可なら null
  installedAt: string
  risk: RiskTag[]
  acceptedRisks: RiskTag[]
  enabled: boolean
}

export type LedgerEntry = LedgerEntryJs | LedgerEntrySubprocess
export type Ledger = { version: 1; providers: Record<string, LedgerEntry> }
```

### managed / unmanaged の判定

| 状況 | ledger | list 表示 | update/remove |
| --- | --- | --- | --- |
| `provider add-js` でインストール | あり (managed:true) | active/disabled | 可 |
| `provider add-subprocess` で登録 | あり (managed:true) | active/disabled | 可 |
| ユーザーが手動で `providers/` に配置 | 無し | unregistered (警告) | 不可 (enable を促す) |
| config.toml 手書き subprocess | 無し | active (unmanaged) | 不可 |

### 並行書き込み対策 (レビュー I-1 反映 — MVP で実装する)

「MVP で許容」は撤回。silently corrupt は SHA 記録喪失につながるため最低限のロックを入れる。

採用: `O_CREAT | O_EXCL` でロックファイル (`provider-ledger.json.lock`) を作る → read → merge → atomic write (temp 同一 dir に書いて rename) → ロック削除。
ロック取得失敗時は短い retry (例: 50ms × 最大 20 回) 後にエラーで中断する。ロックファイルが残った場合に備え、mtime が一定 (例: 60s) を超えた lock は stale とみなして奪取してよい。

---

## 3. SHA256 / atomic move の正しい実装 (レビュー I-8 / C-4 反映)

### SHA256: `Bun.file().sha256()` は存在しない → `Bun.CryptoHasher` を使う (検証済み)

```typescript
async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(path).bytes())
  return hasher.digest('hex')
}
```

### atomic move: temp を `providers/` と同一ディレクトリに置く (C-4 / C-2(roundtrip) 反映)

cross-filesystem の `copyFile → unlink` は非 atomic で TOCTOU 窓が残るため採らない。
ステージングを `$XDG_CACHE_HOME` ではなく `<PROVIDER_DIR>/.tmp-<uuid>.<ext>` にすることで `rename()` が常に同一パーティション内で動き atomic になる。

```
1. DL/読込 → <PROVIDER_DIR>/.tmp-<uuid>.<ext> へ書き込み
2. SHA256 / 静的 manifest 検証 (§下記)
3. rename(<PROVIDER_DIR>/.tmp-<uuid>.<ext>, <PROVIDER_DIR>/<id>.<ext>)   ← atomic
4. 失敗時は .tmp-<uuid>.<ext> を unlink
```

`.tmp-*` は `getUserProviders()` の glob (`/\.(ts|mjs|js)$/`) で拾われるため、走査側で先頭 `.tmp-` を除外する。
さらに起動時に `<PROVIDER_DIR>/.tmp-*` の孤立ファイルをクリーンアップする (C-2 roundtrip)。

---

## 3.5 manifest 検証はコード実行しない (レビュー C-2 / C-4 / I-6 反映 — 設計の根本修正)

元設計の「`bun eval` で manifest の shape を確認」は廃棄する。
DL したリモートコードを検証目的で実行すること自体が任意コード実行 (トップレベル副作用) であり、SHA 検証では防げない。

採用する検証方式:
1. ファイルを文字列として読み込む (実行しない)。
2. `export default { ... }` ブロックを静的に探し、`id`(文字列リテラル) と `group`(関数/アロー) キーの存在を確認する。
   - 正規表現ではなく軽量パーサで `export default` オブジェクトの先頭トークンを見る程度に留める (過度な AST 依存はしない)。
3. `id` が取れなければ「manifest 不正」として中断 (tmp を削除)。
4. risk 確認はこの後 (manifest からテキスト抽出した `risk` 配列リテラルがあれば読む。取れなければ「リスク不明」として `--accept-unknown` を要求するのではなく、リスク無し扱いだが install 時に「manifest から risk を静的に読めなかった」warning を出す)。

実際の `import()`/実行は server 起動時の gate 通過後にのみ起こる (= ユーザーが明示登録した後)。
install フェーズでは一切コードを実行しない。これにより install は「ファイル取得 + 静的検証 + 記録」のみになる。

> 制約: 静的検証は動的に組み立てた manifest (`export default makeManifest()` 等) を読めない。
> その場合 `id` をテキスト抽出できないため install は失敗する。これは意図的な制約 (静的に読めない provider は拒否)。

---

## 4. autoload gate の実装 (確定)

`status.ts` の変更。

```typescript
// 変更1: loaded Map を「パス → ProviderDef」で持つのは維持するが、
//        getUserProviders は cfg を受け取り gate する。
async function getUserProviders(cfg: ServerConfig): Promise<ProviderDef[]> {
  // ... readdir + import (現行どおり、.tmp-* は除外) ...
  // gate: cfg.providers[id] が存在するものだけ返す。
  //       ledger 登録分は merge で cfg.providers に注入済み。
  return [...loaded.values()].filter((p) => cfg.providers[p.id] !== undefined)
}
```

### 同一 id 複数パスの扱い (レビュー C-1 roundtrip 反映)

`loaded` のキーはパス、値の id は manifest 由来なので、別パスに同名 manifest が存在し得る。
確定ポリシー: gate 通過後、id 重複があれば「パスのソート順で最初の 1 件」を採用し、残りは `console.warn` で衝突を通知する。`buildStatusDoc` の `byId` Map 構築時に first-wins を明示する。

### legacy (filename=id) フォールバックの gate 漏れ (レビュー C-1 roundtrip 反映)

現行の「default が関数 → filename を id」経路は、`weather.ts` を置くだけで `cfg.providers["weather"]` があれば gate を通ってしまう。
確定: legacy 経路も gate は同じ (`cfg.providers[id]` 必須) なので「ファイルを置くだけ」では通らない。ただし「config に別目的で `[providers.weather]` を書いていると手動配置ファイルが有効化される」副作用は残る。これを避けるため legacy 経路は deprecation warning を出し、将来削除する (§Roadmap)。

### disable→enable サイクルと TTL キャッシュ (レビュー I-3 roundtrip 反映)

`loaded` Map はファイル削除時のみエントリ削除する (現行どおり)。gate の filter は返却を絞るだけで Map からは消さない。
disable された provider は active セットから外れるので poll されず、TTL キャッシュ (`ttlCache`) は自然に参照されなくなる (再 enable 時は TTL 切れで再計算)。この動作を仕様としてコメントに明記する。

---

## 5. merge ロジック (config.toml + ledger) — 確定 (レビュー C-3 roundtrip 反映)

`loadServerConfig()` で ledger を読み、`mergeProviders(configProviders, ledgerProviders)` で統合する。

### enabled の優先順位 (3 段階に確定)

元設計の「config 優先 (ledger 無視)」は `disable` が効かないバグを生むため改定する。

```
各 id について:
1. config.toml にセクションがあり enabled が明示されている → config.enabled を採用
2. config.toml にセクションはあるが enabled 未指定     → ledger.enabled を採用 (なければ true)
3. config.toml にセクションが無い (ledger のみ)        → ledger.enabled を採用
```

実装上、`mergeProviders` は「config に enabled キーが存在するか」を区別する必要がある (単純 spread 不可)。
`'enabled' in configSection` で判定する。

### 注入ルール

```
- config.toml の [providers.<id>] が存在: そのオプション (apiKey 等) を base にする
- ledger の subprocess エントリで config に無い: command/args/timeoutMs/ttlMs を cfg.providers[id] に注入
- ledger の JS エントリで config に無い: 空オプション {} を cfg.providers[id] に注入 (gate 通過のため。C-1/I-6 roundtrip)
- enabled は上記 3 段優先で決定
```

これにより install の Step6 (ledger) 完了・Step7 (config 追記) 未完了でクラッシュしても、次回 merge で gate を通りリカバリーできる。

---

## 6. risk 宣言と承認フロー (確定)

### JS manifest

```typescript
export type JsProviderManifest = {
  id: string
  risk?: RiskTag[]
  version?: string
  group: (ctx: ProviderCtx) => Promise<Group | null> | Group | null
  dispose?: () => void | Promise<void>   // レビュー I-4: リソース解放契約
}
```

### 承認フロー (レビュー I-2 反映)

```
install/update:
  risk 空/undefined → 確認なし
  未承認タグあり    → リスクを表示し中断、--accept-risk <tags> を要求
  --accept-risk で全タグ指定 → acceptedRisks に記録して続行

update:
  「現 manifest.risk のうち acceptedRisks に無いタグ」だけ再承認を要求
  (削除→再追加は差分検出しない = 許容範囲。設計上明記)

update --all (I-2 確定):
  risk 再承認が必要な件は「skip + エラー扱い」にし、最後に
  「以下は --accept-risk を付けて個別更新してください: <id list>」と表示
  1 件の失敗/skip で全体を止めない (シリアル継続)
```

### subprocess risk

manifest が無いため `add-subprocess --accept-risk <tag>,...` で宣言する。

---

## 7. dispose 契約 (レビュー I-4 反映)

JS provider が timer / listener / socket を持つ場合に備え `dispose?()` を manifest に追加する。
`loaded.delete(path)` の直前に `dispose?.()` を呼ぶ。
ES module キャッシュ問題は「restart 必須」で許容するが、dispose 未実装は長時間稼働でリークするため契約として用意する。MVP では呼び出し側 (`status.ts` のファイル削除検出箇所) に組み込む。

---

## 8. コマンド構文 (確定)

共通: HTTPS 強制・絶対パス強制・atomic move・静的検証は §3 / §3.5 に従う。

### `provider list [--json]`

```
ID | Kind | Status | Version/SHA | Managed | Risk

Status:
  active       - 有効で正常
  disabled     - enabled=false (config/ledger)
  drift        - installedSha256 とファイル実 SHA256 が不一致 (手動変更通知。エラーではない)
  unregistered - providers/ にファイルがあるが config/ledger に無い (警告)
```

> 実装は `add-js` と `add-subprocess` を **`provider install`** に統合し、引数の数で判別する
> (1 つ = JS plugin / id は manifest 由来、2 つ以上 = subprocess `<id> <command>`)。以下の各 Step は
> その install 内の JS / subprocess 経路としてそのまま有効。

### `provider install <https-url | absolute-path>` (JS plugin 経路) [--accept-risk <tag>,...] [--force]

```
Step 0: URL scheme チェック (C-3)。protocol !== 'https:' は拒否。ローカルは絶対パス必須。
Step 1: <PROVIDER_DIR>/.tmp-<uuid>.<ext> へ DL/コピー (C-4: 同一 dir staging)
Step 2: sha256File(tmp)。ledger に (id 一致 かつ 同 sha256) があれば冪等 exit 0 (I-1 roundtrip)
Step 3: 静的 manifest 検証 (§3.5、コード実行しない)。id 取得失敗で中断
Step 4: risk 確認。未承認タグありで中断 (--accept-risk 要求)
Step 5: dest=<PROVIDER_DIR>/<id>.<ext>。dest 既存かつ source 異なる場合 --force 必須。rename(tmp, dest)
Step 6: ledger upsert (ロック付き、§2)
Step 7: config.toml に [providers.<id>] 空セクションが無ければ追記 (§9)
Step 8: "Installed. Restart server to activate." 表示
失敗時: 各 Step で tmp を unlink
```

重複チェック確定 (I-1 roundtrip): キーは `(id, sha256)`。
- 同 id・同 sha256 → 冪等 (already installed、exit 0)
- 同 id・異 sha256 → Step5 の `--force` 判定へ (= 入れ替え)
- 異 id・同 sha256 → 別 id として install を許可 (同一内容を別名で登録するユースケースを潰さない)

### `provider install <id> <command> [-- args...] [--timeout ms] [--ttl ms] [--accept-risk tag,...] [--force]` (subprocess 経路)

```
Step 1: id 重複チェック (ledger)。既存は --force 必須
Step 2: command が cwd 相対 (区切りあり非絶対) なら エラー。bare(PATH 解決) と絶対パスは許可 (I-3 改: subprocess.ts の env=PATH のみと整合、MCP/i3blocks 慣習)。絶対パスなら sha256 を記録
Step 3: builtin と同名 id なら警告表示 (I-5 roundtrip。拒否はしない = 上書きは advanced 用途)
Step 4: risk 確認 (--accept-risk)
Step 5: ledger upsert (env は記録しない。I-5 security)
Step 6: "Registered. Config live on next poll (no restart)."
```

`--env` フラグは提供しない (I-5)。秘密はユーザーの shell/launchd 環境に置き、command 側で読む。
将来必要なら `$XDG_CONFIG_HOME/eveng2-toolbar/secrets/<id>.env` のパスのみ ledger に記録する案 (OPEN DECISION ではなく将来 §Roadmap)。

### `provider remove <id> [--keep-file]`

```
JS:
  1. ledger から削除 (ロック付き)
  2. --keep-file でなければ providers/<id>.<ext> を削除 (ledger.ext を使う)
  3. config.toml の [providers.<id>] セクションを削除 (§9。コメント損失警告)
subprocess:
  1. ledger から削除
  2. config の managed セクションがあれば削除
  3. command バイナリ本体は削除しない
```

### `provider enable <id>` / `disable <id>`

```
config.toml にセクションがあれば enabled を書き換え (行ベース、§9)。
無ければ ledger.enabled を書き換え。
反映は次 poll (最大 3s)。restart 不要。
```

### `provider check-updates [<id>]` (レビュー I-4 review:roundtrip 反映)

```
JS (source=https):
  HEAD で ETag 取得 → ledger.etag と比較
  ETag が応答・ledger 双方に無い → 「ETag 非対応。確認には provider update <id> (フル DL) が必要」
    (null===null で "up to date" と誤判定しない)
subprocess:
  command の SHA256 を再計算 → installedSha256 と比較 → drift 表示
```

### `provider update <id> [--accept-risk tag,...]` / `update --all`

```
JS:
  1. ledger.source から DL → .tmp-<uuid> (C-4 staging)
  2. sha256 == installedSha256 → "already up to date" exit 0
  3. 静的 manifest 再検証 (§3.5)。id 不一致は中断
  4. 新 risk タグ (acceptedRisks 差分) があれば --accept-risk 要求
  5. rename(tmp, dest)
  6. ledger 更新 (installedSha256/etag/installedAt/acceptedRisks)
  7. "Updated. Restart server to activate."
--all: 全 managed JS をシリアル更新。risk 要求件は skip + エラー扱いで継続 (I-2)。末尾に skip 一覧を表示。
subprocess: update は登録情報の確認のみ (コマンド DL はしない)。check-updates を先に。
```

### `provider reload`

MVP: 「手動で再起動してください」を表示するのみ。SIGUSR2 自己再起動は将来 (§11)。

---

## 9. config.toml 追記・削除 (`config-writer.ts`) — 確定 (レビュー I-2 roundtrip 反映)

`smol-toml.stringify` は使わない (コメント損失)。行ベースのテキスト操作にするが、TOML 配列・配列テーブルの誤判定を防ぐ。

```
appendSection(id):  ファイル末尾に "\n[providers.<id>]\n" を appendFile
removeSection(id):
  - セクション開始は行頭 ^\[ のみで判定する (値中の "[" を誤検出しない)
  - 行頭 ^\[\[ (配列テーブル) も「次セクション」として境界に含める
  - [providers.<id>] 行から、次の行頭 ^\[ または EOF までを削除
  - 直前のコメント行も巻き込んで削除する旨をユーザーに警告表示
```

> 堅牢性メモ: より厳密には smol-toml で parse して該当 id の行範囲を特定する手もあるが、
> コメント保持の問題が残るため MVP は行ベース + 行頭 `^\[`/`^\[\[` 限定で確定する。

---

## 10. 既存コードへの変更点

| ファイル | 変更 |
| --- | --- |
| `server/types.ts` | `RiskTag` / `JsProviderManifest`(risk?,version?,dispose?) / `LedgerEntry*` / `Ledger` 追加 |
| `server/config.ts` | `LEDGER_PATH` 定数、`loadLedger()`/`saveLedger()` (ロック付き)、`mergeProviders()`、`loadServerConfig()` で ledger merge |
| `server/status.ts` | `getUserProviders(cfg)` に gate、`.tmp-*` 除外、起動時 `.tmp-*` クリーンアップ、id 衝突 first-wins、`dispose?()` 呼び出し、legacy 経路 deprecation warning |
| `server/subprocess.ts` | `command` に `isAbsolute` チェック追加 (I-3) |
| `server/index.ts` | `process.argv[2] === 'provider'` で `./cli/provider.ts` へ委譲 |
| `package.json` | `bin` に `"eveng2-toolbar": "./server/index.ts"` 追加 |
| 新規 `server/cli/provider.ts` | サブコマンド dispatch |
| 新規 `server/cli/install.ts` | DL / sha256(CryptoHasher) / staging / 静的検証 / atomic move / risk |
| 新規 `server/cli/ledger.ts` | ledger CRUD + O_EXCL ロック |
| 新規 `server/cli/config-writer.ts` | append/removeSection (行頭 `^\[`/`^\[\[` 限定) |
| `examples/provider.example.ts` | `risk` / `dispose` のコメント例 |
| `PROTOCOL.md §9` | manifest の `risk?`/`version?`/`dispose?` を追記 |
| `README.md` | CLI セクション、unregistered 移行手順、Phase 1 前の運用注意 |

---

## 11. プラットフォーム / 既知の制約 (レビュー I-7 反映)

- 対象は macOS / Linux のみ。Windows 非対応を README に明記する。
- `provider reload` の SIGUSR2 自己再起動は Bun が SIGUSR2 を未サポートなため将来検討。
  将来案: UNIX domain socket (macOS/Linux) で reload シグナルを受ける。Windows 対応は named pipe が必要だが対象外。
- パス組み立ては `node:path` の `join` を使う (現行 `config.ts` は正しい)。config-writer の文字列マッチは OS 非依存。

---

## 12. 実装ロードマップ (MVP → 次 → 将来)

### MVP (セキュリティを最初に閉じる)

Phase 1 — gate + ledger 基盤 (C-1 を最優先で閉じる):
- [ ] `status.ts`: `getUserProviders(cfg)` gate、`.tmp-*` 除外/起動時クリーンアップ、id 衝突 first-wins
- [ ] `types.ts`: `RiskTag` / `Ledger` / `LedgerEntry*`
- [ ] `config.ts`: `LEDGER_PATH`、`loadLedger`/`saveLedger` (O_EXCL ロック)、`mergeProviders` (3 段 enabled 優先 + JS/subprocess 注入)
- [ ] `subprocess.ts`: `command` 絶対パスチェック (I-3)
- [ ] README: Phase 1 前は `providers/` を空に保つ運用注意

Phase 2 — CLI 骨格と list/enable/disable:
- [ ] `index.ts` argv 分岐、`cli/provider.ts` dispatch
- [ ] `list` (ledger + loaded + unregistered + drift)
- [ ] `enable`/`disable` (config 行操作 or ledger)
- [ ] `cli/config-writer.ts` (append/removeSection、行頭限定正規表現)

Phase 3 — JS install/update/remove (静的検証・HTTPS・atomic):
- [ ] `cli/install.ts`: HTTPS 強制 (C-3)、CryptoHasher (I-8)、同一 dir staging + rename (C-4)、静的 manifest 検証 (C-2、コード実行なし)
- [ ] `cli/ledger.ts` CRUD
- [ ] `add-js`/`remove`/`update`/`update --all` (risk skip 継続、I-2)
- [ ] `types.ts`: `JsProviderManifest` (risk?/version?/dispose?)、`status.ts` の `dispose?()` 呼び出し (I-4)
- [ ] `examples/provider.example.ts`、`PROTOCOL.md §9` 更新

Phase 4 — subprocess add/remove/check-updates:
- [ ] `add-subprocess` (絶対パス command、builtin 同名警告、env 不記録)
- [ ] `check-updates` (ETag 非対応の誤判定回避)
- [ ] drift 検出 (SHA256 再計算)

Phase 5 — ドキュメントと移行:
- [ ] README CLI セクション、移行ガイド (手動配置 → `provider enable <id>`)
- [ ] legacy filename=id 経路の deprecation 告知

### 次 (MVP 後)
- subprocess の secrets ファイル分離 (`secrets/<id>.env` のパスのみ ledger 記録)
- `provider reload` の自己再起動 (UNIX domain socket)
- update 時の `manifest.changelogUrl` を open

### 将来
- 中央レジストリ / `<name>` 名前解決 (現状は URL/path 直接のみ)
- live JS reload (Worker + dynamic import)
- Windows 対応 (named pipe reload)

---

## 13. OPEN DECISIONS — 確定済み (ユーザー判断 2026-05-30)

- **OD-A 手置きファイルの移行 = 手動 enable 必須 (安全)。** providers/ の既存ファイルは `provider list` で unregistered 警告 → `provider enable <id>` で初めて有効化。「置けば動く」を断つ (C-1 を閉じる)。§1/§4 のとおり。
- **OD-B builtin 差し替え = 警告のみ・許可。** `add-subprocess` で builtin 同名 id は警告を出して許可 (advanced カスタマイズ)。§8 add-subprocess Step3 を確定採用。
- **OD-C 動的 manifest = 拒否 (安全)。** 静的に id を読めない provider (`export default makeManifest()` 等) は install 失敗。install 時のコード実行 (C-2) を避ける。§3.5 を確定採用。
- **OD-D ledger ロック = O_EXCL ロック + atomic write。** §2 を確定採用 (JSON Lines append は不採用)。

---

## データフロー図

```
provider add-js <https-url>
  |
  +- scheme check (https only)            [C-3]
  +- DL -> <PROVIDER_DIR>/.tmp-<uuid>     [C-4 same-dir staging]
  +- sha256File (Bun.CryptoHasher)        [I-8]
  +- (id, sha256) dup check (ledger)      [I-1 roundtrip]
  +- static manifest check (NO eval)      [C-2]
  +- risk gate (--accept-risk)            [I-2]
  +- rename(tmp -> <id>.<ext>)            [C-4 atomic]
  +- ledger upsert (O_EXCL lock)          [I-1]
  +- config append [providers.<id>]       [I-2 roundtrip: line-based]

server poll /api/status
  |
  +- loadServerConfig()
  |    +- read config.toml         [3s TTL]
  |    +- loadLedger()
  |    +- mergeProviders()         [3-tier enabled; inject js+subprocess]  [C-3]
  +- buildStatusDoc(mergedCfg)
       +- getUserProviders(cfg)    [gate: cfg.providers[id] exists; first-wins]  [C-1]
       +- BUILTINS
       +- subprocess (abs command) [I-3]
```
