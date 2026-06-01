// `status-deck provider <subcmd>` の dispatch。
// list / enable / disable / install / update / remove / check-updates。
// install は引数の形で判別: 1 つ = JS plugin、2 つ以上 = subprocess (id + command)。
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadLedger, loadServerConfig, PROVIDER_DIR } from '../config.ts'
import {
  appendSection,
  hasSection,
  readConfigText,
  setEnabled,
  writeConfigText,
} from './config-writer.ts'
import { addJs, addSubprocess, checkUpdates, fileSha, removeProvider, updateJs } from './install.ts'
import { updateLedger } from './ledger.ts'

const BUILTIN_IDS = new Set(['claude-code', 'codex', 'system'])

// provider id は TOML キー / ファイル名として安全な文字に限る (壊れた TOML 生成を防ぐ)。
const ID_RE = /^[A-Za-z0-9_-]+$/

function isSubprocess(opts: unknown): boolean {
  return (
    !!opts &&
    typeof opts === 'object' &&
    typeof (opts as { command?: unknown }).command === 'string'
  )
}

// providers/ の <basename> → ファイル名 (.tmp-* と非対象拡張子は除外、先勝ち)。
async function jsFilesByName(): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  try {
    for (const f of (await readdir(PROVIDER_DIR)).sort()) {
      const mm = /^(?!\.tmp-)(.+)\.(ts|mjs|js)$/.exec(f)
      if (mm?.[1] && !m.has(mm[1])) m.set(mm[1], f)
    }
  } catch {
    // ディレクトリ無し
  }
  return m
}

function printTable(rows: string[][]): void {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? []
  for (const r of rows) {
    console.log(
      r
        .map((cell, c) => (cell ?? '').padEnd(widths[c] ?? 0))
        .join('  ')
        .trimEnd(),
    )
  }
}

async function cmdList(): Promise<void> {
  const cfg = await loadServerConfig()
  const ledger = await loadLedger()
  const files = await jsFilesByName()

  const ids = new Set<string>([...BUILTIN_IDS, ...Object.keys(cfg.providers)])
  const rows: string[][] = [['ID', 'KIND', 'STATUS', 'MANAGED', 'NAME']]
  for (const id of [...ids].sort()) {
    const opts = cfg.providers[id]
    const kind = BUILTIN_IDS.has(id) ? 'builtin' : isSubprocess(opts) ? 'subprocess' : 'js'
    // builtin は config 無し (opts undefined) でも有効。registered なら enabled で判定。
    let status = opts === undefined ? 'active' : opts.enabled !== false ? 'active' : 'disabled'
    const led = ledger.providers[id]
    // drift: managed js の実ファイル sha が ledger と不一致 (インストール後に手で書き換え)。
    if (led?.kind === 'js' && status === 'active') {
      const file = files.get(id)
      if (file && (await fileSha(join(PROVIDER_DIR, file))) !== led.installedSha256)
        status = 'drift'
    }
    // NAME: manifest 由来の表示名 (js のみ。無ければ '-')。
    const name = led?.kind === 'js' && led.name ? led.name : '-'
    rows.push([id, kind, status, led ? 'managed' : '-', name])
  }
  printTable(rows)

  // 未登録ファイル (providers/ にあるが builtin でも登録済みでもない) を警告。
  const unregistered = [...files.keys()].filter((id) => !ids.has(id))
  for (const id of unregistered) {
    console.log(
      `\nunregistered: providers/${files.get(id)} (未登録 → \`provider enable ${id}\` で有効化)`,
    )
  }
}

// 反映は実行中サーバーの次 poll (最大 3s)。restart 不要。
async function cmdEnable(id: string): Promise<void> {
  const text = await readConfigText()
  if (hasSection(text, id)) {
    const next = setEnabled(text, id, true)
    if (next !== null) {
      await writeConfigText(next)
      done(id, 'enabled (config)')
      return
    }
  }
  const ledger = await loadLedger()
  if (ledger.providers[id]) {
    let changed = false
    await updateLedger((l) => {
      const e = l.providers[id]
      if (e) {
        e.enabled = true
        changed = true
      }
    })
    done(id, changed ? 'enabled (ledger)' : 'ledger から消えていました (no-op)')
    return
  }
  // 未登録 → config に [providers.<id>] を追記して登録 + 有効化 (OD-A 移行)。
  await writeConfigText(appendSection(text, id))
  const files = await jsFilesByName()
  if (!BUILTIN_IDS.has(id) && !files.has(id)) {
    console.warn(
      `warning: providers/${id}.{ts,mjs,js} が見つかりません (builtin でもない)。空セクションのみ作成しました`,
    )
  }
  done(id, 'registered + enabled (config)')
}

async function cmdDisable(id: string): Promise<void> {
  const text = await readConfigText()
  if (hasSection(text, id)) {
    const next = setEnabled(text, id, false)
    if (next !== null) {
      await writeConfigText(next)
      done(id, 'disabled (config)')
      return
    }
  }
  const ledger = await loadLedger()
  if (ledger.providers[id]) {
    let changed = false
    await updateLedger((l) => {
      const e = l.providers[id]
      if (e) {
        e.enabled = false
        changed = true
      }
    })
    done(id, changed ? 'disabled (ledger)' : 'ledger から消えていました (no-op)')
    return
  }
  // builtin / 未登録ファイルを止める → enabled=false のセクションを作る。
  await writeConfigText(appendSection(text, id, false))
  done(id, 'disabled (config)')
}

function done(id: string, what: string): void {
  console.log(`${id}: ${what}. 反映は実行中サーバーの次 poll (最大 3s)、restart 不要。`)
}

// 簡易フラグ parser。--force / --keep-file / --all / --timeout / --ttl と positional を分ける。
// `--` 以降は passthrough (add-subprocess の command 引数として渡す)。
function parseArgs(rest: string[]): {
  positional: string[]
  passthrough: string[]
  force: boolean
  keepFile: boolean
  all: boolean
  timeoutMs?: number
  ttlMs?: number
} {
  const positional: string[] = []
  let passthrough: string[] = []
  let force = false
  let keepFile = false
  let all = false
  let timeoutMs: number | undefined
  let ttlMs: number | undefined
  const num = (s: string | undefined): number | undefined => {
    const v = Number(s)
    return Number.isInteger(v) && v > 0 ? v : undefined
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? ''
    if (a === '--') {
      passthrough = rest.slice(i + 1) // 以降はそのまま (command の引数)
      break
    }
    if (a === '--force') force = true
    else if (a === '--keep-file') keepFile = true
    else if (a === '--all') all = true
    else if (a === '--timeout' || a === '--ttl') {
      const v = rest[++i]
      const p = num(v)
      if (p === undefined)
        console.warn(`warning: ${a} の値 '${v}' が不正です (正の整数のみ)。既定値を使います`)
      else if (a === '--timeout') timeoutMs = p
      else ttlMs = p
    } else if (a.startsWith('--')) console.warn(`warning: 未知のフラグ ${a} を無視します`)
    else positional.push(a)
  }
  return { positional, passthrough, force, keepFile, all, timeoutMs, ttlMs }
}

async function cmdUpdateAll(): Promise<void> {
  const ledger = await loadLedger()
  const ids = Object.values(ledger.providers)
    .filter((e) => e.kind === 'js')
    .map((e) => e.id)
  const failed: string[] = []
  for (const id of ids) {
    try {
      console.log(`${id}: ${await updateJs(id)}`)
    } catch (e) {
      console.error(`${id}: ${e instanceof Error ? e.message : String(e)}`)
      failed.push(id)
    }
  }
  if (failed.length) console.log(`\n失敗 (個別に update を再実行): ${failed.join(', ')}`)
}

function requireValidId(sub: string, id: string | undefined): id is string {
  if (!id) {
    console.error(`usage: status-deck provider ${sub} <id>`)
    process.exitCode = 1
    return false
  }
  if (!ID_RE.test(id)) {
    console.error(`invalid id '${id}': [A-Za-z0-9_-] のみ使えます`)
    process.exitCode = 1
    return false
  }
  return true
}

export async function runProviderCli(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  const flags = parseArgs(rest)
  switch (sub) {
    case 'list':
      await cmdList()
      return
    case 'enable':
    case 'disable': {
      const id = flags.positional[0]
      if (!requireValidId(sub, id)) return
      if (sub === 'enable') await cmdEnable(id)
      else await cmdDisable(id)
      return
    }
    case 'install': {
      // 引数の形で判別: 1 つ = JS plugin (id は manifest 由来)、2 つ以上 = subprocess (id + command)。
      const pos = flags.positional
      if (pos.length === 0) {
        console.error(
          'usage:\n' +
            '  provider install <https-url|abs-path>                 # JS plugin\n' +
            '  provider install <id> <command> [-- args...] [--timeout ms] [--ttl ms]   # subprocess\n' +
            '  共通: [--force]',
        )
        process.exitCode = 1
        return
      }
      if (pos.length === 1) {
        await addJs(pos[0] as string, { force: flags.force })
        return
      }
      const id = pos[0] as string
      const command = pos[1] as string
      if (!requireValidId('install', id)) return
      if (/^https?:\/\//i.test(command)) {
        console.error(
          'command が URL です。JS plugin のインストールは引数 1 つ: `provider install <url>`',
        )
        process.exitCode = 1
        return
      }
      await addSubprocess(id, command, flags.passthrough, {
        timeoutMs: flags.timeoutMs,
        ttlMs: flags.ttlMs,
        force: flags.force,
      })
      return
    }
    case 'remove': {
      const id = flags.positional[0]
      if (!requireValidId(sub, id)) return
      await removeProvider(id, flags.keepFile)
      return
    }
    case 'check-updates': {
      const id = flags.positional[0]
      if (id && !ID_RE.test(id)) {
        console.error(`invalid id '${id}'`)
        process.exitCode = 1
        return
      }
      await checkUpdates(id)
      return
    }
    case 'update': {
      if (flags.all) {
        await cmdUpdateAll()
        return
      }
      const id = flags.positional[0]
      if (!requireValidId(sub, id)) return
      console.log(`${id}: ${await updateJs(id)}`)
      return
    }
    default:
      console.log(
        'usage: status-deck provider <list|enable|disable|install|update|remove|check-updates> ...',
      )
      process.exitCode = sub ? 1 : 0
  }
}
