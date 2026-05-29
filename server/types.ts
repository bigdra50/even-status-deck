// server/ 内部で使う型。ワイヤ型 (Group/Segment/StatusDoc) は src/status-types.ts を
// 単一ソースとして再 export し、server → src の片方向依存のみに保つ (循環なし)。
import type { Group } from '../src/status-types.ts'

export type { Group, Segment, StatusDoc } from '../src/status-types.ts'

// provider 実行コンテキスト。config.providers[id] のオプションをそのまま渡す。
export type ProviderCtx = { options: Record<string, unknown> }

// builtin / JS plugin provider の manifest。id を a-priori に持つことで、計算前に
// config の enabled を適用でき、無効 provider は spawn も送信もしない。
export type ProviderDef = {
  id: string
  group: (ctx: ProviderCtx) => Promise<Group | null> | Group | null
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

// $XDG_CONFIG_HOME/eveng2-toolbar/config.{toml,json} の解決済み形。
// providers[id] は command 有無で builtin/JS か subprocess かを判別する。
export type ServerConfig = {
  port?: number
  providers: Record<string, ProviderOpts | SubprocessEntry>
}
