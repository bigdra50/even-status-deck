// macOS のネイティブ通知を取得して POST /api/emit に転送する watcher (PROTOCOL §11)。
//
// 仕組み: 通知センターの SQLite DB (usernoted) を低頻度でポーリングし、新着レコードの
// data BLOB (binary plist) を plutil で復号して title/subtitle/body を取り出し、loopback の
// /api/emit に notification として投げる。emit は loopback 限定なので同一 Mac から届く。
//
// 必要権限: この watcher を動かすプロセス (ターミナル / bun) に Full Disk Access。
//   System Settings > Privacy & Security > Full Disk Access に追加する。
// 依存: macOS 標準の `sqlite3` と `plutil` (どちらもプリインストール)。bun/node どちらでも動く。
//
// 注意: usernoted の DB スキーマ / plist 構造は非公開で macOS 版により変わりうる (壊れやすい)。
//   読めない行は黙ってスキップし、watcher 全体は落とさない。
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadServerConfig } from '../config.ts'

const pexec = promisify(execFile)

const DB = join(homedir(), 'Library/Group Containers/group.com.apple.usernoted/db2/db')
const POLL_MS = 2_000
const PROVIDER_ID = 'mac-notifications'

type Row = { recId: number; identifier: string; hex: string }

// immutable=1 で live DB をロックせず読む。app テーブルを join して bundle id を得る。
async function queryNewRows(lastRecId: number): Promise<Row[]> {
  const sql =
    'SELECT record.rec_id, app.identifier, hex(record.data) ' +
    'FROM record JOIN app ON app.app_id = record.app_id ' +
    `WHERE record.rec_id > ${lastRecId} ORDER BY record.rec_id`
  const { stdout } = await pexec('sqlite3', ['-separator', '', `file:${DB}?immutable=1`, sql], {
    maxBuffer: 32 * 1024 * 1024,
  })
  const rows: Row[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [rec, identifier, hex] = line.split('')
    const recId = Number.parseInt(rec ?? '', 10)
    if (Number.isFinite(recId) && hex) rows.push({ recId, identifier: identifier ?? '', hex })
  }
  return rows
}

async function maxRecId(): Promise<number> {
  try {
    const { stdout } = await pexec('sqlite3', [`file:${DB}?immutable=1`, 'SELECT max(rec_id) FROM record'])
    const n = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

type Notif = { title: string; sub: string; body: string }

function pickStr(o: unknown, keys: string[]): string {
  if (!o || typeof o !== 'object') return ''
  const rec = o as Record<string, unknown>
  for (const k of keys) if (typeof rec[k] === 'string') return rec[k] as string
  return ''
}

// plist JSON から通知文面を取り出す。req 配下 or root 直下のどちらにも対応する。
function extractFromJson(j: unknown): Notif {
  const root = j && typeof j === 'object' ? (j as Record<string, unknown>) : {}
  const req = root.req && typeof root.req === 'object' ? root.req : root
  return {
    title: pickStr(req, ['titl', 'title']),
    sub: pickStr(req, ['subt', 'subtitle']),
    body: pickStr(req, ['body', 'informativeText', 'message']),
  }
}

// XML plist から正規表現で取り出す (JSON 変換が失敗する binary 混在 plist 用のフォールバック)。
function extractFromXml(xml: string, key: string): string {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`).exec(xml)
  if (!m?.[1]) return ''
  return m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// data BLOB (hex) を plist 復号して通知文面にする。JSON を試し、失敗したら XML フォールバック。
async function decodeNotif(hex: string, tmpFile: string): Promise<Notif | null> {
  await writeFile(tmpFile, Buffer.from(hex, 'hex'))
  try {
    const { stdout } = await pexec('plutil', ['-convert', 'json', '-o', '-', tmpFile])
    return extractFromJson(JSON.parse(stdout))
  } catch {
    try {
      const { stdout } = await pexec('plutil', ['-convert', 'xml1', '-o', '-', tmpFile])
      return {
        title: extractFromXml(stdout, 'titl') || extractFromXml(stdout, 'title'),
        sub: extractFromXml(stdout, 'subt'),
        body: extractFromXml(stdout, 'body'),
      }
    } catch {
      return null
    }
  }
}

async function emit(endpoint: string, recId: number, n: Notif): Promise<void> {
  // overlay notification の {app,sender,body} に対応づける: app=タイトル / sender=サブタイトル / body=本文。
  const payload = {
    providerId: PROVIDER_ID,
    id: `mac:${recId}`,
    kind: 'notification',
    app: n.title,
    sender: n.sub,
    body: n.body,
    ttlMs: 20_000,
  }
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    console.error('[mac-notifications] emit failed:', e instanceof Error ? e.message : e)
  }
}

// watcher 本体。引数なしでこの process が生き続ける限りポーリングし続ける。
export async function runMacNotificationsWatcher(): Promise<void> {
  const cfg = await loadServerConfig()
  const envPort = Number(process.env.EVENG2_PORT)
  const port = cfg.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 8723)
  const endpoint = `http://127.0.0.1:${port}/api/emit`

  // 起動時の最大 rec_id を起点にする (過去の通知を遡って洪水しない)。
  let lastRecId: number
  try {
    lastRecId = await maxRecId()
  } catch (e) {
    console.error(
      '[mac-notifications] 通知 DB を読めません。Full Disk Access を付与してください ' +
        '(System Settings > Privacy & Security > Full Disk Access)。',
    )
    console.error('  DB:', DB)
    console.error('  詳細:', e instanceof Error ? e.message : e)
    process.exit(1)
  }

  const dir = await mkdtemp(join(tmpdir(), 'eveng2-noti-'))
  const tmpFile = join(dir, 'n.plist')
  console.log(`[mac-notifications] watching → ${endpoint} (rec_id > ${lastRecId})`)

  // 簡易ループ。エラーは握りつぶして次の tick へ (一過性のロック等で落とさない)。
  for (;;) {
    try {
      const rows = await queryNewRows(lastRecId)
      for (const row of rows) {
        lastRecId = Math.max(lastRecId, row.recId)
        const n = await decodeNotif(row.hex, tmpFile)
        if (!n) continue
        if (!n.title && !n.sub && !n.body) continue // 空通知はスキップ
        await emit(endpoint, row.recId, n)
      }
    } catch (e) {
      console.error('[mac-notifications] poll error:', e instanceof Error ? e.message : e)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}
