#!/usr/bin/env bun
// jscpd 重複率と FTA worst score を shields endpoint JSON に書き出す。
// CI badges workflow から bun run badges <outDir> で呼ぶ。
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JSCPD = join(ROOT, 'node_modules/.bin/jscpd')
const FTA = join(ROOT, 'node_modules/.bin/fta')

const outDir = process.argv[2]
if (!outDir) {
  console.error('usage: bun run scripts/badges.mjs <outDir>')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

/** @returns {{ status: number | null, stdout: string, stderr: string }} */
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...opts,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

let exitCode = 0

// --- jscpd ---
const jscpdTmp = mkdtempSync(join(tmpdir(), 'jscpd-badge-'))
const jscpdRun = run(JSCPD, [
  'src',
  'server',
  '--reporters',
  'json',
  '--output',
  jscpdTmp,
  '--silent',
])

let duplicationPct = null
const jscpdReportPath = join(jscpdTmp, 'jscpd-report.json')
try {
  const report = JSON.parse(await Bun.file(jscpdReportPath).text())
  duplicationPct = report.statistics.total.percentage
} catch {
  if (jscpdRun.status !== 0) {
    process.exit(jscpdRun.status ?? 1)
  }
  console.error('failed to read jscpd report')
  process.exit(1)
}

if (jscpdRun.status !== 0) {
  exitCode = jscpdRun.status ?? 1
}

// --- fta ---
/** @returns {number | null} */
function maxFtaScore(target) {
  const ftaRun = run(FTA, [target, '--json'])
  if (ftaRun.status !== 0 && !ftaRun.stdout.trim()) {
    if (exitCode === 0) exitCode = ftaRun.status ?? 1
    return null
  }
  try {
    const files = JSON.parse(ftaRun.stdout)
    if (!Array.isArray(files) || files.length === 0) return null
    if (ftaRun.status !== 0 && exitCode === 0) {
      exitCode = ftaRun.status ?? 1
    }
    return Math.max(...files.map((f) => f.fta_score))
  } catch {
    if (exitCode === 0) exitCode = ftaRun.status ?? 1
    return null
  }
}

const ftaSrc = maxFtaScore('src')
const ftaServer = maxFtaScore('server')
const ftaScores = [ftaSrc, ftaServer].filter((s) => s !== null)
if (ftaScores.length === 0) {
  process.exit(exitCode || 1)
}
const ftaWorst = Math.max(...ftaScores)

// --- shields JSON ---
function jscpdColor(pct) {
  if (pct < 2.5) return 'brightgreen'
  if (pct < 3) return 'yellow'
  return 'red'
}

// しきい値は lint:fta の score-cap 120 に連動 (cap 変更時はここも揃える)。
function ftaColor(score) {
  if (score < 85) return 'brightgreen'
  if (score < 105) return 'yellow'
  if (score < 120) return 'orange'
  return 'red'
}

const dupMsg = `${duplicationPct.toFixed(1)}%`
const ftaMsg = `${ftaWorst.toFixed(1)} / 120`

const jscpdBadge = {
  schemaVersion: 1,
  label: 'duplication',
  message: dupMsg,
  color: jscpdColor(duplicationPct),
}

const ftaBadge = {
  schemaVersion: 1,
  label: 'fta worst',
  message: ftaMsg,
  color: ftaColor(ftaWorst),
}

await Bun.write(join(outDir, 'jscpd.json'), `${JSON.stringify(jscpdBadge)}\n`)
await Bun.write(join(outDir, 'fta.json'), `${JSON.stringify(ftaBadge)}\n`)

console.log(`duplication: ${dupMsg} (${jscpdBadge.color})`)
console.log(`fta worst: ${ftaMsg} (${ftaBadge.color})`)

if (exitCode !== 0) {
  process.exit(exitCode)
}
