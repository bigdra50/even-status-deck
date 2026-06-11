// PROTOCOL §9c の subprocess provider executor。
// 外部コマンドを spawn し、stdout の JSON を StatusDoc または単一 Group として解釈する。
// セキュリティ不変条件: shell:false / 絶対パス args のみ / 出力サイズ上限 / 最小 env。
// TTL キャッシュと同時実行 dedup は status.ts が所有する (ここでは持たない)。
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { parseStatusDoc } from '../src/status-types.ts'
import { asGroup } from './group-validate.ts'
import type { Group, SubprocessProviderConfig } from './types.ts'

// stdout の累積上限。これを超えたら kill しエラーにする (途中バッファは parse しない)。
const MAX_OUTPUT_BYTES = 512 * 1024
// timeoutMs 未指定時の既定タイムアウト。
const DEFAULT_TIMEOUT_MS = 3_000

export type SubprocessResult = { ok: true; group: Group } | { ok: false; error: string }

// args を解決する。${configDir} のみ展開を許可し、それ以外の ${...} token や
// 非絶対パスが 1 つでもあれば配列全体を null (= 全拒否) にする。filter は使わない。
export function resolveArgs(args: string[], configDir: string): string[] | null {
  const result: string[] = []
  for (const a of args) {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: '${configDir}' は展開対象の固定トークン (テンプレート文字列ではない)
    const expanded = a.replaceAll('${configDir}', configDir)
    if (expanded.includes('${')) return null // 未知 token
    if (!isAbsolute(expanded)) return null // 相対パス / 非絶対
    result.push(expanded)
  }
  return result
}

// StatusDoc を試し、null なら単一 Group として解釈する 2 段デコード (PROTOCOL §9c は両形式可)。
function decode(json: unknown, id: string): Group | null {
  const doc = parseStatusDoc(json)
  if (doc) return doc.groups.find((g) => g.id === id) ?? doc.groups[0] ?? null
  return asGroup(json)
}

export async function runSubprocess(
  id: string,
  cfg: SubprocessProviderConfig,
  configDir: string,
): Promise<SubprocessResult> {
  // command が path 区切りを含むのに絶対パスでない = cwd 相対解決になり危険なので拒否する。
  // 区切りを含まない bare command (例 "python3") は PATH 解決を許可する (MCP / i3blocks と同様)。
  if (/[/\\]/.test(cfg.command) && !isAbsolute(cfg.command)) {
    return { ok: false, error: 'command must be a bare name (PATH) or an absolute path' }
  }
  const args = resolveArgs(cfg.args ?? [], configDir)
  if (args === null) {
    return { ok: false, error: 'invalid args (non-absolute path or unknown token)' }
  }

  return new Promise<SubprocessResult>((resolve) => {
    // PATH 未設定なら env を渡さず継承もしない (PATH:undefined の文字列化を避ける)。
    const env = process.env.PATH ? { PATH: process.env.PATH } : {}
    const proc = spawn(cfg.command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    })

    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (r: SubprocessResult): void => {
      if (done) return
      done = true
      try {
        proc.kill()
      } catch {
        // noop
      }
      resolve(r)
    }

    // 上限超過は kill + エラー。途中バッファは JSON.parse しない。
    proc.stdout.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_OUTPUT_BYTES) {
        finish({ ok: false, error: 'output size limit exceeded' })
        return
      }
      chunks.push(c)
    })
    proc.on('error', () => finish({ ok: false, error: 'spawn failed' }))
    proc.on('close', () => {
      if (done) return
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        finish({ ok: false, error: 'invalid JSON' })
        return
      }
      const group = decode(parsed, id)
      finish(group ? { ok: true, group } : { ok: false, error: 'no valid group' })
    })
    setTimeout(() => finish({ ok: false, error: 'timeout' }), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  })
}
