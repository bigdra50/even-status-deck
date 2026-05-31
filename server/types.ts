// server/ 内部で使う型。ワイヤ型 (Group/Segment/StatusDoc) は src/status-types.ts を
// 単一ソースとして再 export し、server → src の片方向依存のみに保つ (循環なし)。
import type { Group } from '../src/status-types.ts'

export type { Group, Segment, StatusDoc } from '../src/status-types.ts'

// provider 実行コンテキスト。config.providers[id] のオプションをそのまま渡す。
export type ProviderCtx = { options: Record<string, unknown> }

// builtin / JS plugin provider の解決済み形。id を a-priori に持つことで、計算前に
// config の enabled を適用でき、無効 provider は spawn も送信もしない。
// dispose は JS plugin がアンロード (ファイル削除/登録解除) されるとき呼ばれる (timer/socket 解放)。
export type ProviderDef = {
  id: string
  group: (ctx: ProviderCtx) => Promise<Group | null> | Group | null
  dispose?: () => void | Promise<void>
}

// JS plugin の default export 契約 (manifest)。group のみ必須、他は任意。
// risk は install/list/update で提示し承認 (--accept-risk) を要求するためのタグ。
export type JsProviderManifest = {
  id: string
  group: (ctx: ProviderCtx) => Promise<Group | null> | Group | null
  risk?: RiskTag[]
  version?: string
  dispose?: () => void | Promise<void>
}

// subprocess provider (PROTOCOL §9c)。外部コマンドを spawn して StatusDoc / 単一 Group を得る。
export type SubprocessProviderConfig = {
  command: string
  args?: string[]
  timeoutMs?: number
  ttlMs?: number
}

// config の provider エントリ共通オプション。enabled 既定 true (未指定=ON)。
export type ProviderOpts = { enabled?: boolean } & Record<string, unknown>

// command を持つ subprocess provider の config エントリ (ProviderOpts と合成)。
export type SubprocessEntry = SubprocessProviderConfig & ProviderOpts

// mac-notifications watcher の転送フィルタ。allow/deny は bundle identifier または
// title に対して照合する (照合規則は shouldForward を参照)。未指定は空配列扱い (全通過)。
// config.toml の記述例:
//   [watchers.mac-notifications]
//   deny = ["com.apple.AddressBook", "Slackbot"]  # 完全一致 or 部分一致 (大小無視) で除外
//   allow = ["com.apple.iCal"]                     # 非空なら一致したものだけ転送
export type MacNotificationsWatcherConfig = {
  allow?: string[]
  deny?: string[]
}

// watcher 設定。providers とは別系統 (provider ではなく副プロセス的な転送元)。任意。
export type WatchersConfig = {
  'mac-notifications'?: MacNotificationsWatcherConfig
}

// $XDG_CONFIG_HOME/status-deck/config.{toml,json} の解決済み形。
// providers[id] は command 有無で builtin/JS か subprocess かを判別する。
export type ServerConfig = {
  port?: number
  providers: Record<string, ProviderOpts | SubprocessEntry>
  watchers?: WatchersConfig
}

// --- provider 管理 (install/update/uninstall) の ledger 型 (tasks/provider-management-design.md) ---
// provider が宣言できるリスクタグ。install/list/update で表示し、自動更新は既定 OFF。
export type RiskTag = 'unofficial-api' | 'terms-risk' | 'account-limitation-risk'

// ledger は CLI(managed) でインストールした provider の記録。手動配置 (unmanaged) は載らない。
// $XDG_STATE_HOME/status-deck/provider-ledger.json に保存する。
export type LedgerEntryJs = {
  id: string
  kind: 'js'
  managed: true
  source: string // "https://..." or "local:<absolutePath>"
  installedSha256: string
  etag: string | null
  installedVersion: string | null
  installedAt: string // ISO8601
  risk: RiskTag[]
  acceptedRisks: RiskTag[]
  enabled: boolean
  ext: 'ts' | 'mjs' | 'js'
}

export type LedgerEntrySubprocess = {
  id: string
  kind: 'subprocess'
  managed: true
  source: string // "command:<command>"
  command: string
  args: string[]
  timeoutMs: number
  ttlMs: number
  installedSha256: string | null
  installedAt: string
  risk: RiskTag[]
  acceptedRisks: RiskTag[]
  enabled: boolean
}

export type LedgerEntry = LedgerEntryJs | LedgerEntrySubprocess
export type Ledger = { version: 1; providers: Record<string, LedgerEntry> }
