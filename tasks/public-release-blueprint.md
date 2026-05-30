# eveng2-toolbar ローカルサーバー公開整備 — 最終実装プラン

元のブループリント + 3 件の敵対的レビュー (vite-decoupling / dist-compile / correctness-security) を統合した、実装可能な確定版。
レビューが見つけた欠陥は本文に修正済みで取り込み、矛盾は解消済み。
依存順序を 5 フェーズに確定し、実装前にユーザー判断が要る項目は末尾 OPEN DECISIONS に分離した。

対象リポジトリ: `/Volumes/CrucialX9/dev/github.com/bigdra50/eveng2-toolbar` (branch `main`)

---

## 0. ゴールと骨格

`vite.config.ts` に同居している dev サーバーのデータソース実装 (provider 群 + Vite middleware) を `server/` へ切り出し、
Vite に依存しない standalone サーバーとして起動できるようにする。
これにより「公開リポジトリを clone して `bun run server` で動く」配布形態を可能にする。

```
現状:
  vite.config.ts (538 行)
    ├ providers: claudeProvider / codexProvider / macSystemProvider
    ├ statusDoc() / machineInfo() / getUserProviders()
    └ devApiPlugin() ── Vite middleware として /api/status, /api/machine を提供

目標:
  server/
    ├ types.ts          内部型 (src/status-types を再 export)
    ├ config.ts         config.toml/json 読み (port + TTL キャッシュ付き)
    ├ machine.ts        machineInfo / hasCli (クロスプラットフォーム)
    ├ status.ts         buildStatusDoc (builtin + subprocess + JS autoload 統合)
    ├ subprocess.ts     subprocess provider executor (§9c)
    ├ bun-server.ts     standalone HTTP (Bun.serve)。ファイル名で Bun 専用を明示
    ├ vite-plugin.ts    Vite dev middleware shim (Node。Bun API を import しない)
    ├ index.ts          bun エントリ (#!/usr/bin/env bun)
    ├ tsconfig.json     server/ 用の型チェック境界 (IDE + 任意 CI)
    └ providers/
        ├ claude.ts     collectUsage のみ (oauth/keychain/rate-limit 全削除)
        ├ codex.ts      codex app-server JSON-RPC (Windows 分岐)
        └ system.ts     systeminformation 置換 (macOS 専用コマンド廃止)
  vite.config.ts        devApiPlugin を server/vite-plugin.ts の import に置換
  package.json          bin / exports / scripts / deps
  src/companion.ts      初期 server URL の扱い (OD-4 で確定)
  public/help.html      Steps を配布形態に合わせて書き換え (OD-2 で確定)
  DESIGN.md             §7 メトリック表と keychain 記述を更新 (rate-limit 削除を反映)
```

設計境界の不変条件 (循環なし): `server/ → src/status-types.ts` の片方向のみ。`src/ → server/` は存在しない。

---

## 1. レビュー指摘の取り込み一覧 (解決済み)

| レビュー指摘 | 深刻度 | 本プランでの解決 |
|---|---|---|
| C-1 / Issue4 / C-1: `resolveArgs` の `filter` が null を黙って落とし全拒否が機能しない | Critical | §3 P2 で `for` ループ + 早期 `return null` 実装に確定。`null` 返却時は呼び出し側で全体拒否 |
| C-3: 単一 Group JSON が `parseStatusDoc` で必ず null になりドロップ | Critical | §3 P2 で「StatusDoc 試行 → null なら単一 Group (`asGroup`) 試行」の 2 段デコードに確定 (PROTOCOL §9c は両形式を許容) |
| C-4: 512KB 切り捨てで壊れた JSON を `JSON.parse` に渡す | Critical | §3 P2 で「上限超過時はプロセス kill + エラー返却、バッファを parse しない」に確定 |
| C-2 (security): `env: { PATH: undefined }` が `"undefined"` 文字列化 | Critical | §3 P2 で `process.env.PATH` 有無を分岐 (無ければ env 全省略=継承しない最小 env) |
| Issue1: `bun build --compile` は変数パスの動的 import を同梱できない (.mjs も) | Critical | OD-2 で配布形態を確定。MVP は bunx/clone ランタイムのみ。JS autoload (`getUserProviders`) は **ランタイム時のみ有効**、compile バイナリでは無効化 (help.html に明記)。compile は将来オプション |
| Issue2: `bunx eveng2-toolbar-server` はワンライナーで動かない | Critical | OD-2 で help.html の文言を確定 (clone + `bun run server` を一次手順に) |
| C-4 (vite-decoupling): `server/types.ts` 再 export が tsconfig 範囲外で型解決不能 | Important | §3 P1 で `server/tsconfig.json` を必須化 (Phase 1 に含める)。R6 の「任意」を撤回 |
| C-2 (vite-decoupling) / 軽微: `Number(undefined) ?? 8723` が NaN | Important | §3 P4 で `cfg.port ?? (Number(env) || 8723)` に確定。さらに `Number.isInteger` ガード追加 |
| C-3 (vite-decoupling): `smol-toml` 昇格漏れで dev/build が即死 | Important | §3 P5 で `dependencies` 昇格を必須チェックリスト化。Phase 5 検証に追加 |
| I-4 (vite-decoupling): `Bun.serve` が `vite-plugin.ts` に漏れると `npm run dev` が壊れる | Important | ファイル名を `bun-server.ts` に変更 + 先頭に `Bun` undefined ガード。vite-plugin は Bun API を import しない |
| Issue3: `loadServerConfig` が毎リクエスト I/O。TTL キャッシュ無し | Important | §3 P1 で config に 3s TTL キャッシュ追加。standalone の高頻度 poll でも I/O が累積しない |
| Issue5 / I-6: `si.currentLoad()` は loadavg と意味が違う (リアルタイム vs 1分平均) + 最大 1s レイテンシ | Important | §3 P2 で採用を明示注記。`Promise.allSettled` で 1 つの例外が全結果を巻き込まないようにする |
| I-6 / P-2: `isBunCompiled()` の `typeof` 判定が常に true | Important | §3 P3 で判定を撤回。`bun build --compile --define IS_COMPILED=true` でビルド時定数を埋め込む方式に確定 (OD-2 が compile を選ぶ場合のみ) |
| I-1 (claude削除範囲): rate-limit 依存コード削除が不完全で TS/runtime エラー | Important | §3 P2 に `claude.ts` の完全実装 (segments=cost/msgs のみ、`pctSegment`/`markError`/`fetchClaudeLimits` 不参照) を明記 |
| I-2: DESIGN.md §7 が削除済み OAuth segments を残し誤誘導 | Important | §3 P5 に DESIGN.md を変更ファイルとして追加 (§7 表・keychain 記述を更新) |
| I-3 / I-3: `ensureDefaultServer` の前提 + prod bundle の `127.0.0.1` 初期 URL が iPhone から自身ループバックを指す | Important | **検証済み** (config.ts:838-846 は「server ソース 0 件のときのみ追加」で前提は正しい)。ただし prod で `127.0.0.1:8723` を自動登録するのは iPhone から不正。OD-4 で「prod は自動登録しない」を推奨案に |
| I-4 (security): TTL キャッシュミス時の async 二重 spawn | Important | §3 P3 で inflight Promise dedup (`Map<id, Promise>`) を採用。builtin (codex 9s spawn) と subprocess の両方に適用 |
| I-5 (security): Windows `shell:false` + `.cmd` の ENOENT | Important | §3 P2 で codex Windows 分岐を `command:'cmd', args:['/c','codex',...]` 形に確定。subprocess 側は §9c どおりユーザー責務 (絶対パス) |
| I-7: Windows disk mount `C:` vs `C:\\` 不一致 | Important | §3 P2 で `mount.toUpperCase()` を `'/'/'C:'/'C:\\'` のいずれかでマッチ |
| Issue7 / P-3: codex 並列 spawn 抑止が standalone で顕在化 | 低 | I-4 の inflight dedup でまとめて解決 (builtin にも適用) |
| P-1: vite.config.ts 行番号のズレ | 情報 | 実コードは 538 行。`devApiPlugin` 509-533 / `export default` 535-538。§3 P5 で行番号を訂正 |

---

## 2. パターンと制約 (実コード確認済み・file:line 根拠)

| 確認事項 | 根拠 |
|---|---|
| `vite.config.ts` は全 538 行。`devApiPlugin` 509-533 / `export default defineConfig` 535-538 | `vite.config.ts:1-538` |
| Vite 依存は `defineConfig` / `ViteDevServer` 型 / `devApiPlugin` middleware のみ | `vite.config.ts:9,512,535` |
| 削除対象: `oauthToken`/`claudeVersion`/`fetchClaudeLimits`/`claudeCache`/`CLAUDE_TTL_MS` | `vite.config.ts:44-92` |
| 残す: `collectUsage`/`pricingFor`/`localDateKey`/`UsageLine`/`Pricing` (純ローカル JSONL 集計) | `vite.config.ts:145-235` |
| `claudeProvider` の rate-limit 4 segment (`session/weekly/sonnet/opus`) + `pctSegment`/`markError` 呼び出し + `fetchClaudeLimits` 呼び出し (268,278,281-284,298) を削除。cost/msgs 2 segment を残す | `vite.config.ts:266-301` |
| `macSystemProvider` は `vm_stat`/`pmset`/`df`/`loadavg` の macOS 専用呼び出し。group id は `'mac'` | `vite.config.ts:337-411,425` |
| `getUserProviders` は変数パスの動的 import (`pathToFileURL(path)`)。`.ts/.mjs/.js` を autoload | `vite.config.ts:464-495` |
| `statusDoc()` は `BUILTINS` + `getUserProviders()` を `Promise.allSettled` で集約 | `vite.config.ts:497-507` |
| `machineInfo`/`hasCli`/`machineCache` (TTL 60s) | `vite.config.ts:19-42` |
| `loadServerConfig` は毎 poll で `config.toml`→`config.json` を読む (TTL なし) | `vite.config.ts:437-450` |
| `ensureDefaultServer(cfg,url)` は **server kind が 1 件もないときのみ** push。既存 config は不変 (前提検証 OK) | `src/config.ts:838-846` |
| companion 初回登録は `location.origin` 固定 (dev/prod 共通) | `src/companion.ts:1486,1495` |
| `parseStatusDoc` は `version:number` + `groups:array` が必須。**単一 Group JSON は null を返す** | `src/status-types.ts:70-73` |
| `asGroup` 相当の単一 Group 検証ロジックは現行 `vite.config.ts:452-459` に存在 (移植する) | `vite.config.ts:452-459` |
| PROTOCOL §9c: subprocess は `shell:false`・timeout+kill・`ttlMs` キャッシュ・同時実行抑止・出力サイズ上限・env 最小 allowlist・出力は StatusDoc **または単一 Group** | `PROTOCOL.md` §9c |
| PROTOCOL §7: CORS は loopback/LAN では **推奨** (必須ではない)。cloud 配信時のみ必須 | `PROTOCOL.md` §7 |
| token/refreshToken はレスポンス・ログ・subprocess に出さない | `DESIGN.md` §7 / `PROTOCOL.md` §9c セキュリティ |
| `smol-toml` は `devDependencies` (v1.6.1) | `package.json:33` |
| `"type":"module"` ESM。`"private":true` | `package.json:3-4` |
| tsconfig `include:["src"]`・`allowImportingTsExtensions`・`noEmit`・`verbatimModuleSyntax`。build は `tsc && vite build` | `tsconfig.json` / `package.json:7` |
| `src/data.ts` の `fetchStatusFrom`/`fetchMachineFrom` は URL に対し `/api/status`・`/api/machine` を叩くだけ (変更不要) | `src/data.ts:59-69` |

---

## 3. フェーズ別 実装仕様

依存順序: Phase 1 (基盤・直列) → Phase 2/3 (並列可能) → Phase 4 (HTTP/エントリ) → Phase 5 (既存ファイル差し替え)。

### Phase 1 — 基盤 (直列・先行必須)

並列不可。以降すべてが依存する。

#### 1-1. `server/tsconfig.json` (新規・必須)

C-4 を解決。`server/` を型チェックする境界を作る。ルート tsconfig (`include:["src"]`) を extends し include を `server` に差し替える。

```jsonc
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["bun"],          // Bun.serve 等の型 (要 @types/bun)
    "noEmit": true
  },
  "include": ["."]
}
```

- `@types/bun` を `devDependencies` に追加 (Bun.serve / Bun.* の型解決用)。
- ルート `tsconfig.json` の `include` は `["src"]` のまま (build の `tsc` は src のみ型チェック。server は Bun が直接実行)。
- 任意 CI は `tsc -p server/tsconfig.json --noEmit` で server を別途型チェックできる。

#### 1-2. `server/types.ts` (新規)

```ts
export type { Group, Segment, StatusDoc } from '../src/status-types.ts'

export type ProviderCtx = { options: Record<string, unknown> }
export type ProviderDef = {
  id: string
  group: (ctx: ProviderCtx) => Promise<Group | null> | Group | null
}

export type SubprocessProviderConfig = {
  command: string
  args?: string[]
  timeoutMs?: number
  ttlMs?: number
}
export type ProviderOpts = { enabled?: boolean } & Record<string, unknown>
export type SubprocessEntry = SubprocessProviderConfig & ProviderOpts

export type ServerConfig = {
  port?: number
  providers: Record<string, ProviderOpts | SubprocessEntry>
}
```

依存: `src/status-types.ts` のみ。

#### 1-3. `server/config.ts` (新規)

`vite.config.ts:428-450` の `CONFIG_DIR`/`PROVIDER_DIR`/`readConfigFile`/`loadServerConfig` を移植。
変更点 2 つ:

1. `port` フィールドのパース追加 (既定なし。解決は index.ts)。
2. **3s TTL キャッシュ** (Issue3 解決)。standalone の高頻度 poll でも config I/O が累積しない。トグルは最大 3s 遅延で反映 (許容)。

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse as parseToml } from 'smol-toml'
import type { ServerConfig } from './types.ts'

export const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'eveng2-toolbar',
)
export const PROVIDER_DIR = join(CONFIG_DIR, 'providers')

const CONFIG_TTL_MS = 3_000
let cache: { data: ServerConfig; at: number } | null = null

export async function loadServerConfig(): Promise<ServerConfig> {
  if (cache && Date.now() - cache.at < CONFIG_TTL_MS) return cache.data
  // readConfigFile('config.toml') ?? readConfigFile('config.json') → providers + port を抽出
  // ...
  cache = { data, at: Date.now() }
  return data
}
```

依存: `server/types.ts`。

---

### Phase 2 — Provider 群 (Phase 1 完了後・互いに並列可能)

#### 2-1. `server/machine.ts` (新規)

`vite.config.ts:19-42` の `machineInfo`/`machineCache`/`MACHINE_TTL_MS`/`hasCli` を移植。
`hasCli` をクロスプラットフォーム化: Windows では `<cmd>.cmd` も試す。

```ts
async function hasCli(cmd: string): Promise<boolean> {
  const cands = process.platform === 'win32' ? [cmd, `${cmd}.cmd`] : [cmd]
  for (const c of cands) {
    try { await pexec(c, ['--version']); return true } catch { /* next */ }
  }
  return false
}
```

依存: `node:child_process`/`node:os`/`node:util`。

#### 2-2. `server/providers/claude.ts` (新規)

`collectUsage`/`pricingFor`/`localDateKey`/`UsageLine`/`Pricing` を移植。oauth/keychain/rate-limit は **移植しない**。
I-1 解決: 完全実装を以下に確定 (segments=cost/msgs のみ。`fetchClaudeLimits`/`pctSegment`/`markError` を一切参照しない)。

```ts
import type { Group, Segment, ProviderCtx } from '../types.ts'
import { hasCli } from '../machine.ts'
// collectUsage / pricingFor / localDateKey / UsageLine / Pricing をここに移植

export async function claudeProvider(_ctx: ProviderCtx): Promise<Group | null> {
  if (!(await hasCli('claude'))) return null
  const usage = (await collectUsage()) as { estCostUsd?: number; messages?: number; error?: unknown }
  const segments: Segment[] = [
    { id: 'cost', label: 'Cost',
      value: usage.estCostUsd != null ? `$${Math.round(usage.estCostUsd)}` : 'n/a',
      defaultEnabled: true },
    { id: 'msgs', label: 'Msgs',
      value: usage.messages != null ? String(usage.messages) : 'n/a',
      defaultEnabled: false },
  ]
  const group: Group = { id: 'claude-code', label: 'Claude', segments }
  if (usage.error != null) { group.state = 'error'; group.message = 'usage log unavailable' }
  return group
}
```

依存: `server/types.ts`/`server/machine.ts`/`node:os`/`node:fs/promises`/`node:path`。

#### 2-3. `server/providers/codex.ts` (新規)

`vite.config.ts:94-143,314-335` の `fetchCodexLimits`/`codexProvider`/`codexCache`/`fmtReset`/`pctSegment` を移植。
**TTL キャッシュは status.ts の inflight dedup に統合**するため、`codexCache` のモジュールスコープ Map は残すが、二重 spawn 抑止は status.ts 側 (I-4) が担う。
Windows 分岐 (I-5 解決): `shell:false` を保ったまま `.cmd` の ENOENT を避けるため `cmd /c` 経由にする。

```ts
const spawnArgs: [string, string[]] = process.platform === 'win32'
  ? ['cmd', ['/c', 'codex', 'app-server']]
  : ['codex', ['app-server']]
const proc = spawn(...spawnArgs, { stdio: ['pipe', 'pipe', 'ignore'] })
```

`proc.on('error', ...)` で ENOENT を捕捉し `{ error: 'codex not found' }` を返してクラッシュさせない (既存挙動踏襲)。

依存: `server/types.ts`/`server/machine.ts`/`node:child_process`/`node:readline`。

#### 2-4. `server/providers/system.ts` (新規)

`macSystemProvider`/`cpuLoadPct`/`macMemUsedPct`/`macBattery`/`diskInfo` を `systeminformation` で置換。
I-6/Issue5 解決: `Promise.allSettled` で 1 つの例外が全結果を巻き込まないようにする。`si.currentLoad()` がリアルタイム使用率である点 (loadavg と意味が違う・最大 1s レイテンシ) を注記コメントで明示。
I-7 解決: disk mount を大文字化して `'/'/'C:'/'C:\\'` のいずれかでマッチ。

```ts
import si from 'systeminformation'
import type { Group, Segment, ProviderCtx } from '../types.ts'

export async function systemProvider(_ctx: ProviderCtx): Promise<Group | null> {
  // NOTE: 旧実装は loadavg(1分平均)。si.currentLoad はリアルタイム使用率で意味が異なり
  // 内部測定で最大 ~1s のレイテンシがある (poll 10-60s では許容)。
  const [loadR, memR, battR, fsR] = await Promise.allSettled([
    si.currentLoad(), si.mem(), si.battery(), si.fsSize(),
  ])
  const segments: Segment[] = []
  if (loadR.status === 'fulfilled') {
    const cpu = Math.round(loadR.value.currentLoad)
    segments.push({ id: 'cpu', label: 'CPU', value: `${cpu}%`, percent: cpu, defaultEnabled: true })
  }
  if (memR.status === 'fulfilled') {
    const m = Math.round((memR.value.used / memR.value.total) * 100)
    segments.push({ id: 'mem', label: 'Mem', value: `${m}%`, percent: m, defaultEnabled: true })
  }
  if (battR.status === 'fulfilled' && battR.value.hasBattery) {
    const b = battR.value
    segments.push({ id: 'battery', label: 'Bat',
      value: `${b.percent}%${b.isCharging ? '+' : ''}`, percent: b.percent, defaultEnabled: false })
  }
  if (fsR.status === 'fulfilled') {
    const root = fsR.value.find((f) => {
      const m = f.mount.toUpperCase()
      return f.mount === '/' || m === 'C:' || m === 'C:\\'
    })
    if (root) {
      const seg: Segment = { id: 'disk', label: 'Disk',
        value: `${Math.round((root.available / 1024 ** 3) * 10) / 10}G`, defaultEnabled: false }
      if (Number.isFinite(root.use)) seg.percent = Math.round(root.use)
      segments.push(seg)
    }
  }
  if (!segments.length) return null
  return { id: SYSTEM_GROUP_ID, label: 'System', segments } // group id は OD-1 で確定
}
```

依存: `server/types.ts`/`systeminformation`。

> R3 注: `systeminformation` v5 は pure JS。macOS のバッテリーは内部で `pmset`/`ioreg` を子プロセスで呼ぶ (現行 `macBattery` と同じ前提で退行ではない)。compile バイナリでの実値検証は OD-2 が compile を選ぶ場合の検証項目。

#### 2-5. `server/subprocess.ts` (新規)

PROTOCOL §9c の executor。C-1/C-2/C-3/C-4 をすべて解決した確定実装。

```ts
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { parseStatusDoc } from '../src/status-types.ts'
import type { Group, SubprocessProviderConfig } from './types.ts'

const MAX_OUTPUT_BYTES = 512 * 1024

export type SubprocessResult = { ok: true; group: Group } | { ok: false; error: string }

// C-1 解決: null が 1 つでも出たら配列全体を null (= 全拒否)。filter は使わない。
export function resolveArgs(args: string[], configDir: string): string[] | null {
  const result: string[] = []
  for (const a of args) {
    const expanded = a.replaceAll('${configDir}', configDir)
    if (expanded.includes('${')) return null            // 未知 token
    if (!isAbsolute(expanded)) return null               // 相対パス / 非絶対
    result.push(expanded)
  }
  return result
}

// C-3 解決: StatusDoc を試し、null なら単一 Group として解釈 (PROTOCOL §9c は両形式可)。
function decode(json: unknown, id: string): Group | null {
  const doc = parseStatusDoc(json)
  if (doc) return doc.groups.find((g) => g.id === id) ?? doc.groups[0] ?? null
  return asGroup(json) // vite.config.ts:452-459 の単一 Group 検証を移植
}

export async function runSubprocess(
  id: string, cfg: SubprocessProviderConfig, configDir: string,
): Promise<SubprocessResult> {
  const args = resolveArgs(cfg.args ?? [], configDir)
  if (args === null) return { ok: false, error: 'invalid args (non-absolute path or unknown token)' }

  return new Promise<SubprocessResult>((resolve) => {
    // C-2 解決: PATH 未設定なら env を渡さず継承もしない (PATH:undefined の文字列化を避ける)。
    const env = process.env.PATH ? { PATH: process.env.PATH } : {}
    const proc = spawn(cfg.command, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env })
    const chunks: Buffer[] = []
    let size = 0, done = false
    const finish = (r: SubprocessResult) => {
      if (done) return; done = true
      try { proc.kill() } catch { /* noop */ }
      resolve(r)
    }
    // C-4 解決: 上限超過は kill + エラー。途中バッファを JSON.parse しない。
    proc.stdout.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_OUTPUT_BYTES) return finish({ ok: false, error: 'output size limit exceeded' })
      chunks.push(c)
    })
    proc.on('error', () => finish({ ok: false, error: 'spawn failed' }))
    proc.on('close', () => {
      if (done) return
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { return finish({ ok: false, error: 'invalid JSON' }) }
      const group = decode(parsed, id)
      finish(group ? { ok: true, group } : { ok: false, error: 'no valid group' })
    })
    setTimeout(() => finish({ ok: false, error: 'timeout' }), cfg.timeoutMs ?? 3_000)
  })
}
```

依存: `server/types.ts`/`src/status-types.ts`/`node:child_process`/`node:path`。
TTL キャッシュと inflight dedup は status.ts が所有 (下記)。

---

### Phase 3 — 集約層 (Phase 2 完了後)

#### 3-1. `server/status.ts` (新規)

`vite.config.ts:413-507` の `BUILTINS`/`getUserProviders`/`loaded` Map/`asGroup`/`statusDoc` を移植・統合。
I-2 (vite-decoupling) / I-4 (security) / Issue7 を解決。

責務:
- `BUILTINS = [{id:'claude-code',group:claudeProvider}, {id:'codex',group:codexProvider}, {id:SYSTEM_GROUP_ID,group:systemProvider}]`
- `getUserProviders()` (JS plugin autoload) を移植。`loaded` Map もここに所有 (移植先を明示)。
  - **compile バイナリでは autoload を無効化** (Issue1)。判定はビルド時定数 `IS_COMPILED` (P3 参照)。runtime では従来どおり `.ts/.mjs/.js` を autoload。
- `cfg.providers[id]` に `command` があれば subprocess、無ければ builtin/JS としてディスパッチ。
- **TTL キャッシュ + inflight Promise dedup** を builtin・subprocess の両方に適用 (I-4/Issue7 解決):

```ts
const ttlCache = new Map<string, { group: Group; at: number }>()
const inflight = new Map<string, Promise<Group | null>>()

function dedup(id: string, ttlMs: number, run: () => Promise<Group | null>): Promise<Group | null> {
  const hit = ttlCache.get(id)
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.group)
  const existing = inflight.get(id)
  if (existing) return existing                      // 同時リクエストは 1 spawn に集約
  const p = run().then((g) => { if (g) ttlCache.set(id, { group: g, at: Date.now() }); return g })
    .finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}
```

- builtin の codex は ttlMs=60s、claude は usage 集計が軽いので dedup のみ (ttl 任意)。subprocess は `cfg.ttlMs ?? 30s`。
- `buildStatusDoc(cfg)` は active provider を `Promise.allSettled` で集約し `{ version:1, ts:Date.now(), groups }` を返す。

```ts
export async function buildStatusDoc(cfg: ServerConfig): Promise<StatusDoc>
```

依存: `server/config.ts`/`server/subprocess.ts`/`server/providers/*.ts`/`src/status-types.ts`。

---

### Phase 4 — HTTP / Vite shim / エントリ (Phase 3 完了後)

#### 4-1. `server/bun-server.ts` (新規。ファイル名で Bun 専用を明示 — I-4 解決)

```ts
// I-4 解決: 万一 Node 経路から import されても即座に明確なエラーを出す。
if (typeof Bun === 'undefined') throw new Error('bun-server.ts requires the Bun runtime')

import { machineInfo } from './machine.ts'
import { buildStatusDoc } from './status.ts'
import { loadServerConfig } from './config.ts'
import type { ServerConfig } from './types.ts'

function respondJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

export function startServer(cfg: ServerConfig, port: number): void {
  Bun.serve({
    port, hostname: '0.0.0.0',
    async fetch(req) {
      const { pathname } = new URL(req.url)
      try {
        if (pathname === '/api/machine') return respondJson(await machineInfo())
        if (pathname === '/api/status') return respondJson(await buildStatusDoc(await loadServerConfig()))
      } catch (e) {
        console.error(`[api] ${pathname} failed:`, e)   // 詳細はサーバーログのみ
        return new Response(JSON.stringify({ error: 'internal error' }), { status: 500 })
      }
      return new Response('Not Found', { status: 404 })
    },
  })
  console.log(`eveng2-toolbar-server listening on http://0.0.0.0:${port}`)
  printAddresses(port)  // OD-3: LAN IP を console 出力 (QR は OD-3 で確定)
}
```

CORS は §7 どおり loopback/LAN では推奨。`*` を付与しておけば cloud/別ポート dev でも困らない。
依存: `server/machine.ts`/`server/status.ts`/`server/config.ts`/`server/types.ts`。Bun ランタイム必須。

#### 4-2. `server/vite-plugin.ts` (新規。Node 上で動く・Bun API を import しない — I-4 解決)

`devApiPlugin` を移植。`server/bun-server.ts` を **import しない** (構造で境界を強制)。

```ts
import type { ViteDevServer } from 'vite'
import { machineInfo } from './machine.ts'
import { buildStatusDoc } from './status.ts'
import { loadServerConfig } from './config.ts'

export function devApiPlugin() {
  return {
    name: 'toolbar-dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/machine', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        try { res.end(JSON.stringify(await machineInfo())) }
        catch (e) { console.error('[api] /api/machine failed:', e); res.statusCode = 500; res.end(JSON.stringify({ error: 'internal error' })) }
      })
      server.middlewares.use('/api/status', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        try { res.end(JSON.stringify(await buildStatusDoc(await loadServerConfig()))) }
        catch (e) { console.error('[api] /api/status failed:', e); res.statusCode = 500; res.end(JSON.stringify({ error: 'internal error' })) }
      })
    },
  }
}
```

依存: `server/machine.ts`/`server/status.ts`/`server/config.ts`/`vite` (型のみ)。Bun 非依存。

#### 4-3. `server/index.ts` (新規・bun エントリ)

C-2 解決: `NaN ?? 8723` を回避。`Number.isInteger` ガードも入れる。

```ts
#!/usr/bin/env bun
import { loadServerConfig } from './config.ts'
import { startServer } from './bun-server.ts'

const cfg = await loadServerConfig()
const envPort = Number(process.env.EVENG2_PORT)
const port = cfg.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 8723)
startServer(cfg, port)
```

依存: `server/config.ts`/`server/bun-server.ts`。

---

### Phase 5 — 既存ファイル差し替え (Phase 4 完了後)

#### 5-1. `vite.config.ts` (変更)

行 1-533 (全 provider ロジック + `devApiPlugin` 実装) を削除し import に置換。`smol-toml`/Node import/Vite 型 import はすべて server/ 側へ移った。

```ts
import { defineConfig } from 'vite'
import { devApiPlugin } from './server/vite-plugin.ts'

export default defineConfig({
  server: { host: true },
  plugins: [devApiPlugin()],
})
```

#### 5-2. `package.json` (変更)

```jsonc
{
  "bin": { "eveng2-toolbar-server": "./server/index.ts" },
  "exports": {
    ".": "./server/index.ts",
    "./vite-plugin": "./server/vite-plugin.ts"
  },
  "scripts": {
    "server": "bun run server/index.ts"
    // OD-2 が compile を選ぶ場合のみ追加:
    // "server:build": "bun build --compile --define IS_COMPILED=true server/index.ts --outfile dist-server/eveng2-toolbar-server"
  },
  "dependencies": {
    "smol-toml": "^1.6.1",          // C-3: devDependencies から昇格 (必須)
    "systeminformation": "^5.23.5"  // 新規
  },
  "devDependencies": {
    "@types/bun": "latest"          // 1-1: server/tsconfig.json の Bun 型
  }
}
```

- `smol-toml` を `devDependencies` から `dependencies` へ移動 (重複させない)。
- `"private": true` 維持 (OD-2 で npm publish しないなら)。

#### 5-3. `src/companion.ts` (変更・OD-4 で確定)

I-3 解決。詳細は OD-4。推奨案 (prod は server を自動登録しない) を採る場合は `companion.ts:1486,1495` の `ensureDefaultServer` 呼び出しを dev 限定にする:

```ts
// dev (ブラウザ / 同一オリジン) のみ自動登録。prod (.ehpk) は登録せず help.html の手順で LAN IP を入力させる。
if (import.meta.env.DEV && ensureDefaultServer(config, location.origin)) await saveConfig(config)
```

#### 5-4. `public/help.html` (変更・OD-2 で確定)

「Steps」を配布形態に合わせて書き換え、Advanced セクション (OD-5) を条件付きで追加。文言は OD-2/OD-5 の結論で確定。

#### 5-5. `DESIGN.md` (変更・I-2 解決)

§7 メトリック表から `session`/`weekly`/`sonnet`/`opus` 行 (`DESIGN.md:184-186`) を削除し「標準 provider から除外。rate-limit % は外部 subprocess provider として opt-in」の注記に置換。
keychain/`/api/oauth/usage` の記述 (`DESIGN.md:~203`) も同様に更新。

---

## 4. データフロー

### standalone モード
```
bun run server/index.ts (または bunx / compile バイナリ)
  └ index.ts → loadServerConfig() [3s TTL] → startServer(cfg, 8723)
       └ Bun.serve(0.0.0.0:8723)
            GET /api/machine → machineInfo() [60s TTL]
            GET /api/status  → buildStatusDoc(cfg)
                 ├ claudeProvider()  ~/.claude/projects/**/*.jsonl   (cost/msgs)
                 ├ codexProvider()   codex app-server JSON-RPC       [60s TTL + dedup]
                 ├ systemProvider()  systeminformation               (cpu/mem/bat/disk)
                 ├ [JS autoload]     providers/*.{ts,mjs,js}         (runtime のみ)
                 └ [subprocess]      cfg.providers[id].command       [ttlMs + dedup]
```

### dev モード (Vite)
```
vite dev → vite.config.ts → devApiPlugin() (server/vite-plugin.ts)
  └ middlewares /api/{machine,status} → 同一の machineInfo / buildStatusDoc
```

フロント (`src/data.ts`) は URL に `/api/status`・`/api/machine` を叩くだけ。この層は変更不要。

---

## 5. 依存順序 (ビルドシーケンス確定)

```
Phase 1 [直列・先行必須]
  1. server/tsconfig.json      (型境界。@types/bun も追加)
  2. server/types.ts
  3. server/config.ts          (port + 3s TTL)

Phase 2 [Phase 1 後・互いに並列可能]
  4a. server/machine.ts
  4b. server/providers/claude.ts
  4c. server/providers/codex.ts
  4d. server/providers/system.ts
  4e. server/subprocess.ts

Phase 3 [Phase 2 全完了後]
  5. server/status.ts          (BUILTINS + getUserProviders + TTL/inflight dedup)

Phase 4 [Phase 3 後]
  6. server/bun-server.ts      (Bun.serve)
  7. server/vite-plugin.ts     (Node middleware・Bun 非依存)
  8. server/index.ts           (port 解決 + startServer)

Phase 5 [Phase 4 後・既存ファイル]
  9.  vite.config.ts           (import 2 行へ削減)
  10. package.json             (bin/exports/scripts/deps)
  11. src/companion.ts         (OD-4)
  12. public/help.html         (OD-2/OD-5)
  13. DESIGN.md                (§7 更新・I-2)
```

---

## 6. リスク (再評価)

- R1 (Bun compile + 動的 import): **配布形態で隔離**。MVP は runtime のみ (OD-2)。compile を選ぶ場合は JS autoload を `IS_COMPILED` 定数で無効化し、拡張は subprocess provider に限定。
- R2 (Bun.serve + compile): 公式サポート。問題なし。
- R3 (systeminformation): v5 は pure JS。macOS バッテリーは子プロセス (`pmset`/`ioreg`) 経由で現行と同等。compile を選ぶ場合のみ実機検証 (OD-2)。
- R4 (Windows codex): `cmd /c codex` 経由 + `proc.on('error')` でクラッシュ回避 (I-5)。
- R5 (循環依存): `server → src` 片方向のみ。なし。
- R6 (tsconfig カバレッジ): `server/tsconfig.json` で解決 (C-4)。
- R7 (dev を壊さない): middleware シグネチャ・エンドポイント・レスポンス形式不変。`smol-toml` 昇格を検証に含める。`vite-plugin.ts` が Bun API を import しない構造保証。

---

## 7. 検証チェックリスト

```
[ ] npm install 後に smol-toml / systeminformation / @types/bun が解決する
[ ] npm run dev で /api/status・/api/machine が JSON を返す (Vite middleware 経由)
[ ] bun run server で 0.0.0.0:8723 が起動し /api/status を返す
[ ] systeminformation が macOS / Linux で cpu/mem/battery/disk を返す
[ ] subprocess provider が config.toml の [providers.weather] で動く (StatusDoc / 単一 Group 両方)
[ ] resolveArgs: 相対パス・未知 token を含む args が全拒否される (部分実行しない)
[ ] 単一 Group JSON を出す subprocess が group を返す (ドロップされない)
[ ] 512KB 超過出力の subprocess が kill + エラーになり JSON.parse でクラッシュしない
[ ] PATH 未設定環境で subprocess が "undefined" 文字列を PATH に入れない
[ ] 同時 /api/status 多発で codex / subprocess が 1 回しか spawn されない (inflight dedup)
[ ] EVENG2_PORT 未設定・cfg.port 未設定で port が 8723 (NaN にならない)
[ ] token / accessToken が /api/status レスポンス・console.log に出ない
[ ] DESIGN.md §7 に session/weekly/sonnet/opus が残っていない
[ ] vite-plugin.ts が server/bun-server.ts / Bun API を import していない (npm run dev が壊れない)
[ ] (compile を選ぶ場合) バイナリで JS autoload が無効・subprocess が動く
```

---

## OPEN DECISIONS (実装前にユーザー判断が必要)

### OD-1: system provider の group id を `'mac'` → `'system'` に変えるか
旧 `macSystemProvider` の group id は `'mac'`。新実装はクロスプラットフォームなので `'system'` が自然だが、
既存ユーザーの companion config に `groupId:'mac'` が保存されている場合、id 変更で配置/可視性が孤児化する
(`src/config.ts` の `pruneOrphans`/`syncSourceWithStatus` は新 group を Unplaced 棚に出すだけで旧配置は残骸化)。
- A: `'system'` に変更。config 側の移行は不要だが、旧ユーザーは `mac` group の残骸が Items に残り、`system` が新規追加扱いで再配置が要る。
- B (MVP 推奨): group id は `'mac'` のまま維持。label のみ `'System'` 等に。provider 関数名だけ `systemProvider`。完全後方互換。
- どちらでも §3 2-4 の `SYSTEM_GROUP_ID` 定数 1 か所で吸収できる。

### OD-2: 配布形態 — bunx / clone-runtime / compile バイナリ
Issue1 (動的 import が compile に乗らない) と Issue2 (`bunx` ワンライナーが動かない) の両方に直結。help.html の文言・package.json scripts・`"private"` がこれで決まる。
- A (MVP 推奨): clone + `bun run server` を一次手順 (help.html の Steps)。`"private":true` 維持。JS autoload も subprocess も動く。compile は後回し。
- B: npm publish (`"private":false`) して `bunx eveng2-toolbar-server` を真のワンライナーに。公開運用 (バージョニング・パッケージ名) の判断が要る。
- C: compile シングルバイナリを GitHub Releases に。JS autoload を `IS_COMPILED` で無効化し拡張は subprocess に限定。実機検証 (systeminformation/child_process) が前提。
- 判断が help.html (OD-5)・companion (OD-4) の文言にも波及する。

### OD-3: 起動時の QR / LAN IP 表示の実装方法
help.html が「server 起動で QR/IP が出る」と書くなら `bun-server.ts` の `printAddresses` を確定する必要がある。
- A: LAN IP を `console.log` で出すだけ (`os.networkInterfaces()` の非内部 IPv4)。追加依存なし。**MVP 推奨**。
- B: `qrcode-terminal` を依存追加して ASCII QR を出力。
- C: `qrcode-terminal` を optionalDependencies にし、無ければ IP のみ。
- 既存 `npm run qr` (`evenhub qr`) は dev 用に残すか整理するかも合わせて判断。

### OD-4: companion の初期 server URL (prod / dev)
I-3 で検証済み: `ensureDefaultServer` は「server ソース 0 件のときのみ追加」なので既存 config は壊さない。
ただし prod (.ehpk) で `http://127.0.0.1:8723` を自動登録すると、**iPhone から見た `127.0.0.1` は iPhone 自身のループバック**で Mac に届かない。
- A (推奨): prod では自動登録しない (`import.meta.env.DEV` のときだけ `ensureDefaultServer(config, location.origin)`)。新規ユーザーは help.html の手順で Mac の LAN IP を入力する。
- B: prod でも `127.0.0.1:8723` を入れるが、これは誤った既定値になるため非推奨。
- C: prod では空の server source を「未設定」プレースホルダとして 1 つ作り、UI で URL 入力を促す (companion UI 変更が増える)。
- §3 5-3 は A を前提に書いている。B/C を選ぶなら 5-3 を差し替える。

### OD-5: help.html「Advanced: third-party sources」と `eveng2-claude-usage-provider` の参照
rate-limit % を削除する代わりに、外部 subprocess provider として opt-in できる旨を help.html に書くか。
- 参照先 `eveng2-claude-usage-provider` リポジトリが公開済み・URL 確定かを確認する必要がある。
- 未公開なら: (a) セクション自体を後続フェーズに先送り / (b) URL を伏せて「rate-limit provider (coming soon)」表記。
- third-party は untrusted の注記 (「信頼するソースだけ追加」) は §9c セキュリティに沿って必ず添える。
