// config.toml の行ベース編集。smol-toml の stringify はコメント・書式を roundtrip できないため
// 使わず、行操作で [providers.<id>] セクションの追加と enabled 行の設定だけを行う。
// セクション境界は行頭 ^[ / ^[[ (TOML テーブル / 配列テーブル) で判定する。三重引用符の
// 複数行文字列の中にある行頭 [ は無視する (それ以外の複雑な TOML 構文は前提にしない)。
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONFIG_DIR } from '../config.ts'

const CONFIG_PATH = join(CONFIG_DIR, 'config.toml')

export async function readConfigText(): Promise<string> {
  try {
    return await readFile(CONFIG_PATH, 'utf8')
  } catch {
    return '' // 無ければ空
  }
}

// atomic 書き込み (同一 dir に temp → rename)。CLI 書き込み途中のクラッシュで config を破損させない。
export async function writeConfigText(text: string): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  const tmp = `${CONFIG_PATH}.tmp-${randomUUID()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, CONFIG_PATH)
}

// 三重引用符 ("""/''') の複数行文字列の内側にある行 index 集合。
// セクション判定 (findSection/sectionEnd) でこれらの行を無視し、文字列中の行頭 [ を誤検出しない。
// 近似実装: 1 行内の delimiter 数が奇数なら開閉が切り替わる前提 (escape や 1 行内混在は非対応)。
function stringBodyLines(lines: string[]): Set<number> {
  const inside = new Set<number>()
  let delim: '"""' | "'''" | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (delim) {
      inside.add(i) // 閉じ delimiter を含む行も「文字列の続き」として無視する
      if (line.includes(delim)) delim = null
      continue
    }
    const open = line.includes('"""') ? '"""' : line.includes("'''") ? "'''" : null
    if (open && (line.split(open).length - 1) % 2 === 1) delim = open // 奇数 = この行で開いて未閉
  }
  return inside
}

// [providers.<id>] ヘッダ行の index (無ければ -1)。完全一致なので [providers.<id>.sub] は別物。
// 複数行文字列の中の行は除外する。
function findSection(lines: string[], id: string): number {
  const header = `[providers.${id}]`
  const body = stringBodyLines(lines)
  return lines.findIndex((l, i) => !body.has(i) && l.trim() === header)
}

// start 以降で次の行頭 [ (^[ または ^[[) が現れる index = セクション終端。無ければ EOF。
// 複数行文字列の中の行頭 [ は終端と見なさない。
function sectionEnd(lines: string[], start: number, body: Set<number>): number {
  for (let i = start; i < lines.length; i++) {
    if (!body.has(i) && /^\s*\[/.test(lines[i] ?? '')) return i
  }
  return lines.length
}

export function hasSection(text: string, id: string): boolean {
  return findSection(text.split('\n'), id) >= 0
}

// 既存セクションの enabled 行を設定/挿入する。セクションが無ければ null (呼び出し側が appendSection)。
export function setEnabled(text: string, id: string, enabled: boolean): string | null {
  const lines = text.split('\n')
  const h = findSection(lines, id)
  if (h < 0) return null
  const end = sectionEnd(lines, h + 1, stringBodyLines(lines))
  let ei = -1
  for (let i = h + 1; i < end; i++) {
    if (/^\s*enabled\s*=/.test(lines[i] ?? '')) {
      ei = i
      break
    }
  }
  // boolean 値だけ差し替えてインデント・インラインコメント (# ...) を残す。
  if (ei >= 0)
    lines[ei] = (lines[ei] ?? '').replace(/^(\s*enabled\s*=\s*)(true|false)\b/, `$1${enabled}`)
  else lines.splice(h + 1, 0, `enabled = ${enabled}`)
  return lines.join('\n')
}

// [providers.<id>] セクション (ヘッダ〜次セクション/EOF) を削除する。無ければ null。
// セクション内のコメントは失われる (呼び出し側で警告する)。前にあるコメント行は残る。
export function removeSection(text: string, id: string): string | null {
  const lines = text.split('\n')
  const h = findSection(lines, id)
  if (h < 0) return null
  const end = sectionEnd(lines, h + 1, stringBodyLines(lines))
  lines.splice(h, end - h)
  return lines.join('\n')
}

// 末尾に [providers.<id>] (+ 任意で enabled) を追記する。既存内容があれば空行で区切る。
// id は呼び出し側で [a-z0-9_-]+ に検証済み前提 (TOML キーとして安全)。
export function appendSection(text: string, id: string, enabled?: boolean): string {
  const body =
    enabled === undefined ? `[providers.${id}]\n` : `[providers.${id}]\nenabled = ${enabled}\n`
  if (text.trim() === '') return body
  const base = text.endsWith('\n') ? text : `${text}\n`
  return `${base}\n${body}`
}
