// `eveng2-toolbar provider <subcmd>` の dispatch (Phase 2: list / enable / disable)。
// add/remove/update/check-updates は Phase 3+。
import { readdir } from 'node:fs/promises'
import { loadLedger, loadServerConfig, PROVIDER_DIR } from '../config.ts'
import {
  appendSection,
  hasSection,
  readConfigText,
  setEnabled,
  writeConfigText,
} from './config-writer.ts'
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
  const rows: string[][] = [['ID', 'KIND', 'STATUS', 'MANAGED', 'RISK']]
  for (const id of [...ids].sort()) {
    const opts = cfg.providers[id]
    const kind = BUILTIN_IDS.has(id) ? 'builtin' : isSubprocess(opts) ? 'subprocess' : 'js'
    // builtin は config 無し (opts undefined) でも有効。registered なら enabled で判定。
    const status = opts === undefined ? 'active' : opts.enabled !== false ? 'active' : 'disabled'
    const led = ledger.providers[id]
    rows.push([
      id,
      kind,
      status,
      led ? 'managed' : '-',
      led?.risk.length ? led.risk.join(',') : '-',
    ])
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

export async function runProviderCli(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'list':
      await cmdList()
      return
    case 'enable':
    case 'disable': {
      const id = rest[0]
      if (!id) {
        console.error(`usage: eveng2-toolbar provider ${sub} <id>`)
        process.exitCode = 1
        return
      }
      if (!ID_RE.test(id)) {
        console.error(`invalid id '${id}': [A-Za-z0-9_-] のみ使えます`)
        process.exitCode = 1
        return
      }
      if (sub === 'enable') await cmdEnable(id)
      else await cmdDisable(id)
      return
    }
    default:
      console.log('usage: eveng2-toolbar provider <list|enable|disable> [id]')
      console.log('  (add / remove / update は今後のフェーズ)')
      process.exitCode = sub ? 1 : 0
  }
}
