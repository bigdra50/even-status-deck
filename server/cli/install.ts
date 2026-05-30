// JS provider の install / update / remove (管理 Phase 3)。
// セキュリティの要: DL したリモートコードを**実行せず**静的に manifest を読む (id / risk)。
// HTTPS 強制、出力サイズ上限、sha256、同一 dir staging → atomic rename、risk 承認、ledger 記録。
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { loadLedger, PROVIDER_DIR } from '../config.ts'
import type { LedgerEntryJs, RiskTag } from '../types.ts'
import {
  appendSection,
  hasSection,
  readConfigText,
  removeSection,
  writeConfigText,
} from './config-writer.ts'
import { updateLedger } from './ledger.ts'

const RISK_TAGS: readonly RiskTag[] = ['unofficial-api', 'terms-risk', 'account-limitation-risk']
const ID_RE = /^[A-Za-z0-9_-]+$/
const MAX_PROVIDER_BYTES = 512 * 1024
type Ext = 'ts' | 'mjs' | 'js'

function isRiskTag(s: string): s is RiskTag {
  return (RISK_TAGS as readonly string[]).includes(s)
}

function sha256(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher('sha256')
  h.update(bytes)
  return h.digest('hex')
}

function deriveExt(source: string): Ext {
  const m = /\.(ts|mjs|js)(?:$|[?#])/i.exec(source)
  const e = m?.[1]?.toLowerCase()
  return e === 'ts' || e === 'mjs' || e === 'js' ? e : 'mjs'
}

// --- 静的 manifest 解析 (コードを実行しない) ----------------------------------------
// `export default { ... }` の object literal を探し、トップレベル (depth 1) の id/risk/version
// だけを抽出する。文字列・コメントはスキップし、group 関数の return 内の id などは拾わない。
// object 以外 (function / 動的 call) は null = reject (OD-C)。完全な JS パーサではなく heuristic。
function skipString(src: string, i: number): number {
  const q = src[i]
  i++
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === q) return i + 1
    i++
  }
  return src.length
}

// src[i] === '[' から matching ] までの中身を返す (文字列内の括弧はスキップ)。無ければ null。
function readArrayLiteral(src: string, i: number): string | null {
  const start = i
  let depth = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return src.slice(start + 1, i)
    }
    i++
  }
  return null
}

export function parseManifestStatic(
  src: string,
): { id: string; risk: RiskTag[]; version: string | null } | null {
  const n = src.length
  // 1. 文字列/コメントを飛ばしつつ `export` `default` `{` の並びを探す。
  let i = 0
  let start = -1
  while (i < n) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      i = e < 0 ? n : e + 2
      continue
    }
    if (src.startsWith('export', i) && /\s/.test(src[i + 6] ?? '')) {
      const m = /^export\s+default\s*\{/.exec(src.slice(i))
      if (m) {
        start = i + m[0].length
        break
      }
    }
    i++
  }
  if (start < 0) return null // object manifest 形でない → reject

  // 2. start (object の中) から depth 1 のキーを拾い、matching } まで進む。
  const fields = new Map<string, string>()
  let depth = 1
  i = start
  while (i < n && depth > 0) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      i = e < 0 ? n : e + 2
      continue
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++
      i++
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--
      i++
      continue
    }
    if (depth === 1 && /[A-Za-z_$]/.test(c ?? '')) {
      const km = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i))
      if (km) {
        const key = km[1] as string
        let vi = i + km[0].length
        while (vi < n && /\s/.test(src[vi] ?? '')) vi++
        if (key === 'id' || key === 'version') {
          const sm = /^(['"])((?:\\.|(?!\1).)*)\1/.exec(src.slice(vi))
          if (sm?.[2] !== undefined) fields.set(key, sm[2])
        } else if (key === 'risk' && src[vi] === '[') {
          // 文字列対応の配列スキャン (文字列内の ] で途切れさせない → risk タグ隠蔽を防ぐ)。
          const arr = readArrayLiteral(src, vi)
          if (arr !== null) fields.set('risk', arr)
        }
        i = vi // 値は次の反復で文字列/括弧として自然にスキップされる
        continue
      }
    }
    i++
  }

  const id = fields.get('id')
  if (!id) return null // id を静的に読めない → reject
  const risk = [...(fields.get('risk') ?? '').matchAll(/['"]([^'"]+)['"]/g)]
    .map((m) => m[1] as string)
    .filter(isRiskTag)
  return { id, risk, version: fields.get('version') ?? null }
}

// --- DL / 検査 ------------------------------------------------------------------------
async function fetchSource(
  source: string,
): Promise<{ bytes: Uint8Array; ext: Ext; etag: string | null }> {
  const ext = deriveExt(source)
  if (/^https?:\/\//i.test(source)) {
    if (!/^https:\/\//i.test(source)) throw new Error('http は不可。https のみ許可します')
    const res = await fetch(source)
    if (!res.ok) throw new Error(`download failed: http ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > MAX_PROVIDER_BYTES)
      throw new Error(`provider が大きすぎます (${bytes.length} bytes)`)
    return { bytes, ext, etag: res.headers.get('etag') }
  }
  if (!isAbsolute(source)) throw new Error('ローカルは絶対パスで指定してください')
  const bytes = new Uint8Array(await readFile(source))
  if (bytes.length > MAX_PROVIDER_BYTES)
    throw new Error(`provider が大きすぎます (${bytes.length} bytes)`)
  return { bytes, ext, etag: null }
}

// 検証済み bytes を providers/<id>.<ext> へ atomic に書く (同一 dir staging → rename)。
async function commit(id: string, ext: Ext, bytes: Uint8Array): Promise<void> {
  await mkdir(PROVIDER_DIR, { recursive: true })
  const tmp = join(PROVIDER_DIR, `.tmp-${randomUUID()}.${ext}`)
  try {
    await writeFile(tmp, bytes)
    await rename(tmp, join(PROVIDER_DIR, `${id}.${ext}`))
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

function checkRisk(risk: RiskTag[], accepted: RiskTag[]): void {
  const unaccepted = risk.filter((r) => !accepted.includes(r))
  if (unaccepted.length) {
    throw new Error(
      `このプロバイダは risk: ${risk.join(', ')} を宣言しています。承認するには --accept-risk ${unaccepted.join(',')} を付けてください`,
    )
  }
}

// --- add-js ---------------------------------------------------------------------------
export async function addJs(
  source: string,
  opts: { acceptRisk: RiskTag[]; force: boolean },
): Promise<void> {
  const { bytes, ext, etag } = await fetchSource(source)
  const sha = sha256(bytes)
  const manifest = parseManifestStatic(new TextDecoder().decode(bytes))
  if (!manifest) {
    throw new Error(
      'manifest を静的に読めません。`export default { id: "..." , group }` 形式が必要です (動的 manifest は非対応)',
    )
  }
  const { id, risk, version } = manifest
  if (!ID_RE.test(id)) throw new Error(`manifest id '${id}' が不正です ([A-Za-z0-9_-] のみ)`)

  const ledger = await loadLedger()
  const existing = ledger.providers[id]
  // 別 kind (subprocess) との置き換えは config の command 残留で JS がロードされないため拒否する。
  if (existing && existing.kind !== 'js') {
    throw new Error(
      `${id} は ${existing.kind} provider として登録済みです。先に \`provider remove ${id}\` してください`,
    )
  }
  if (existing?.installedSha256 === sha) {
    console.log(`${id}: already installed (同一 sha256)`)
    return // 冪等
  }
  // risk を先に確認 (--force より前) し、両方必要なら 1 回で分かるようにする。
  checkRisk(risk, opts.acceptRisk)
  if (existing && !opts.force) {
    throw new Error(`${id} は既にインストール済みです。置き換えるには --force`)
  }

  await commit(id, ext, bytes)
  const entry: LedgerEntryJs = {
    id,
    kind: 'js',
    managed: true,
    source: /^https:\/\//i.test(source) ? source : `local:${source}`,
    installedSha256: sha,
    etag,
    installedVersion: version,
    installedAt: new Date().toISOString(),
    risk,
    acceptedRisks: opts.acceptRisk.filter((r) => risk.includes(r)),
    enabled: true,
    ext,
  }
  await updateLedger((l) => {
    l.providers[id] = entry
  })
  const cfgText = await readConfigText()
  if (!hasSection(cfgText, id)) await writeConfigText(appendSection(cfgText, id))
  console.log(`${id}: installed (${ext})。反映は実行中サーバーの次 poll (最大 3s)、restart 不要。`)
}

// --- update ---------------------------------------------------------------------------
// 戻り値: 'updated' | 'uptodate' | 'risk' (新 risk 未承認で skip)。
export async function updateJs(
  id: string,
  opts: { acceptRisk: RiskTag[] },
): Promise<'updated' | 'uptodate' | 'risk'> {
  const ledger = await loadLedger()
  const entry = ledger.providers[id]
  if (!entry || entry.kind !== 'js')
    throw new Error(`${id} は managed な JS provider ではありません`)
  const source = entry.source.startsWith('local:')
    ? entry.source.slice('local:'.length)
    : entry.source
  const { bytes, ext, etag } = await fetchSource(source)
  const sha = sha256(bytes)
  if (sha === entry.installedSha256) return 'uptodate'
  const manifest = parseManifestStatic(new TextDecoder().decode(bytes))
  if (!manifest) throw new Error(`${id}: manifest を静的に読めません`)
  if (manifest.id !== id)
    throw new Error(`${id}: 更新先の manifest id (${manifest.id}) が一致しません`)

  // 新しく増えた risk タグだけ再承認を要求する。
  const newRisks = manifest.risk.filter(
    (r) => !entry.acceptedRisks.includes(r) && !opts.acceptRisk.includes(r),
  )
  if (newRisks.length) return 'risk'

  await commit(id, ext, bytes)
  await updateLedger((l) => {
    const e = l.providers[id]
    if (e?.kind === 'js') {
      e.installedSha256 = sha
      e.etag = etag
      e.installedVersion = manifest.version
      e.installedAt = new Date().toISOString()
      e.risk = manifest.risk
      e.acceptedRisks = [...new Set([...e.acceptedRisks, ...opts.acceptRisk])].filter((r) =>
        manifest.risk.includes(r),
      )
      e.ext = ext
    }
  })
  return 'updated'
}

// --- remove ---------------------------------------------------------------------------
export async function removeProvider(id: string, keepFile: boolean): Promise<void> {
  const ledger = await loadLedger()
  const entry = ledger.providers[id]
  // 順序: config → file → ledger。途中クラッシュしても「ledger に残る = managed として再 remove 可能」
  // に倒す (ledger を先に消すと孤児ファイルが stale config で gate を通る)。
  const cfgText = await readConfigText()
  const next = removeSection(cfgText, id)
  if (next !== null) {
    await writeConfigText(next)
    console.warn(
      `note: config の [providers.${id}] を削除しました (セクション内のコメントは失われます)`,
    )
  }
  // file 削除 (ledger の ext を使う。ledger 外の手動配置は全拡張子を試す)。
  if (!keepFile) {
    if (entry?.kind === 'js') {
      await unlink(join(PROVIDER_DIR, `${id}.${entry.ext}`)).catch(() => {})
    } else if (!entry) {
      for (const e of ['ts', 'mjs', 'js'] as Ext[]) {
        await unlink(join(PROVIDER_DIR, `${id}.${e}`)).catch(() => {})
      }
    }
  }
  // 最後に ledger から削除。
  if (entry) {
    await updateLedger((l) => {
      delete l.providers[id]
    })
  }
  console.log(`${id}: removed${keepFile ? ' (file kept)' : ''}。`)
}
