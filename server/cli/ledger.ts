// ledger の書き込み (O_EXCL ロック + atomic write)。読み (loadLedger) は config.ts が持つ。
// CLI (provider enable/disable, 将来の add/remove/update) からのみ呼ぶ。サーバー本体は読むだけ。
import { randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { LEDGER_PATH, loadLedger, STATE_DIR } from '../config.ts'
import type { Ledger } from '../types.ts'

const LOCK_PATH = `${LEDGER_PATH}.lock`
const LOCK_RETRY_MS = 50
const LOCK_RETRY_MAX = 20
const LOCK_STALE_MS = 60_000 // この時間より古い lock は stale とみなし奪取する

// O_EXCL ロックを取り、mutate で ledger を変更して atomic write する。
// ロック取得は短い retry。残留した stale lock (mtime 超過) は奪取する。
export async function updateLedger(mutate: (ledger: Ledger) => void): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  let handle: FileHandle | undefined
  for (let i = 0; i < LOCK_RETRY_MAX && !handle; i++) {
    try {
      handle = await open(LOCK_PATH, 'wx') // O_CREAT | O_EXCL | O_WRONLY
    } catch {
      try {
        const st = await stat(LOCK_PATH)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await unlink(LOCK_PATH).catch(() => {})
          continue // 即 retry (奪取)
        }
      } catch {
        // lock が消えた → retry
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
    }
  }
  if (!handle) throw new Error('ledger lock の取得に失敗しました')
  try {
    const ledger = await loadLedger() // ロック下で最新を読む
    mutate(ledger)
    const tmp = `${LEDGER_PATH}.tmp-${randomUUID()}`
    await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    await rename(tmp, LEDGER_PATH) // 同一 dir → atomic
  } finally {
    await handle.close()
    await unlink(LOCK_PATH).catch(() => {})
  }
}
