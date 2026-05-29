#!/usr/bin/env node
// Even Hub への build アップロード自動化。
// 公式 evenhub CLI に upload コマンドが無いため、Web UI が使う API を呼ぶ:
//   1) POST /api/v1/versions/draft?package_id=<pkg>   FormData{ehpk:file}     → draft_id
//   2) POST /api/v1/versions/create?package_id=<pkg>  FormData{draft_id,changelog} → build 登録 (公開)
// 認証: ~/.config/evenhub/credentials.yaml の access_token を X-Even-Authorization ヘッダに載せる
//   (evenhub login で取得・保存される。Bearer 接頭辞なし)。
//
// 使い方:
//   node scripts/upload.mjs                      # draft のみ (安全。公開しない)
//   node scripts/upload.mjs --publish -m "説明"   # draft → create (= Add build 公開)
//   オプション: --file <ehpk> --package <id> -m/--changelog <text>
//
// 注意: access_token が失効 (401) したら `evenhub login` を再実行する。

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.EVENHUB_API_URL || 'https://hub.evenrealities.com'
const CRED = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'evenhub', 'credentials.yaml')

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n)
    if (i >= 0) return process.argv[i + 1] ?? true
  }
  return undefined
}
function has(name) {
  return process.argv.includes(name)
}

// credentials.yaml をパースする。YAML の折りたたみブロックスカラー (`key: >-` の次行に値) と
// インライン (`key: value`) の両方に対応。evenhub login が書く形式。値は表示しない。
function readCreds() {
  let text
  try {
    text = readFileSync(CRED, 'utf8')
  } catch {
    throw new Error(`認証情報が読めません: ${CRED}\nまず自分のターミナルで \`evenhub login\` を実行してください。`)
  }
  const lines = text.split('\n')
  const out = {}
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-z_]+)\s*:\s*(.*)$/)
    if (!m) continue
    const [, key, rest] = m
    const v = rest.trim()
    if (/^[>|][+-]?$/.test(v)) {
      // ブロックスカラー: 後続のインデント行を集めて連結 (token は単一トークン=空白なし結合)
      const parts = []
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+\S/.test(lines[j])) parts.push(lines[j].trim())
        else if (lines[j].trim() === '') continue
        else break
      }
      out[key] = parts.join('')
    } else {
      out[key] = v.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

// 更新トークンを credentials.yaml に書き戻す (インライン plain scalar。JWT は YAML 特殊文字を含まない)。
function writeCreds(c) {
  const order = [
    'email',
    'role',
    'access_token',
    'refresh_token',
    'access_token_expires_in',
    'refresh_token_expires_in',
  ]
  const body = order
    .filter((k) => c[k] !== undefined)
    .map((k) => `${k}: ${c[k]}`)
    .join('\n')
  writeFileSync(CRED, `${body}\n`, { mode: 0o600 })
}

// refresh_token で access_token を更新する (POST /api/v1/auth/refresh, 認証ヘッダ不要)。
async function refresh(creds) {
  const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: creds.refresh_token }),
  })
  const body = await res.json().catch(() => ({ code: -1 }))
  if (body.code !== 0 || !body.data?.access_token) {
    throw new Error('トークン更新に失敗しました。`evenhub login` を再実行してください。')
  }
  const updated = {
    ...creds,
    access_token: body.data.access_token,
    refresh_token: body.data.refresh_token ?? creds.refresh_token,
    access_token_expires_in: body.data.access_token_expires_in ?? creds.access_token_expires_in,
    refresh_token_expires_in: body.data.refresh_token_expires_in ?? creds.refresh_token_expires_in,
  }
  writeCreds(updated)
  return updated
}

// state.creds を使って POST。401 なら一度だけ refresh して再試行。form は () => FormData で都度生成。
const state = { creds: null }
async function api(path, makeForm, pkg, retried = false) {
  const url = `${BASE}${path}?package_id=${encodeURIComponent(pkg)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Even-Authorization': state.creds.access_token },
    body: makeForm(),
  })
  if (res.status === 401 && !retried) {
    state.creds = await refresh(state.creds)
    return api(path, makeForm, pkg, true)
  }
  let body
  try {
    body = await res.json()
  } catch {
    body = { code: -1, message: `非JSON応答 (HTTP ${res.status})` }
  }
  if (body.code !== 0) {
    throw new Error(`API エラー (HTTP ${res.status}, code ${body.code}): ${body.message ?? JSON.stringify(body)}`)
  }
  return body.data
}

async function main() {
  const app = JSON.parse(readFileSync('app.json', 'utf8'))
  const pkg = arg('--package') || app.package_id
  const file = arg('--file') || 'eveng2-toolbar.ehpk'
  const changelog = arg('-m', '--changelog') || ''
  const doPublish = has('--publish')
  state.creds = readCreds()
  const version = app.version

  console.log(`package : ${pkg}`)
  console.log(`file    : ${file} (app.json version ${version})`)
  console.log(`mode    : ${doPublish ? 'draft → create (公開)' : 'draft のみ (安全)'}`)

  // 1) draft upload
  const buf = readFileSync(file)
  const name = file.split('/').pop()
  const draft = await api(
    '/api/v1/versions/draft',
    () => {
      const f = new FormData()
      f.append('ehpk', new Blob([buf], { type: 'application/octet-stream' }), name)
      return f
    },
    pkg,
  )
  const draftId = draft?.draft_id ?? draft?.id ?? draft?.draftId
  console.log(`✓ draft uploaded: draft_id=${draftId}`)
  if (!draftId) {
    console.log('draft 応答にdraft_idが見当たりません。応答全体:', JSON.stringify(draft))
    throw new Error('draft_id を取得できませんでした (応答フィールド名を確認してください)')
  }

  if (!doPublish) {
    console.log('\ndraft のみ完了 (公開していません)。公開するには --publish を付けて再実行してください。')
    return
  }

  // 2) create (= Add build 公開)
  const created = await api(
    '/api/v1/versions/create',
    () => {
      const f = new FormData()
      f.append('draft_id', String(draftId))
      if (changelog) f.append('changelog', changelog)
      return f
    },
    pkg,
  )
  console.log(`✓ build published: ${JSON.stringify(created)}`)
}

main().catch((e) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
