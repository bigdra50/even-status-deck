#!/usr/bin/env bun
// server/index.ts を node / bun 両ランタイムで動く単一 dist-server/index.js にバンドルする。
// .ts 拡張子の import はビルド時に解決。systeminformation/smol-toml は external (npm が install)。
// 動的 import(pathToFileURL(...)) のプラグイン autoload はバンドルされず実行時 import のまま残る。
// 出力先頭を node shebang に差し替え、bunx/npx どちらからも実行できるようにする。
import { rm } from 'node:fs/promises'

const OUTDIR = './dist-server'
const OUTFILE = `${OUTDIR}/index.js`

await rm(OUTDIR, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ['./server/index.ts'],
  outdir: OUTDIR,
  target: 'node',
  format: 'esm',
  external: ['systeminformation', 'smol-toml'],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Bun.build は entry の shebang を保持しないため、node shebang を明示的に付与する。
// 既存の先頭 shebang があれば差し替える (二重化防止)。
const built = (await Bun.file(OUTFILE).text()).replace(/^#![^\n]*\n/, '')
await Bun.write(OUTFILE, `#!/usr/bin/env node\n${built}`)
console.log(`built ${OUTFILE}`)
