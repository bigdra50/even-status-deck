// Phase 4: 接続検出ベースのプリセット切替「提案」(DESIGN.md §4 / §10)。
// 現在オンラインな server source の集合に最も合致する profile を 1 つ選ぶ純粋関数群。
// 自動適用はしない (companion がバナーで提示し、ユーザー承認で Phase 2 の切替を呼ぶ)。
// 副作用なし: 入力 (config + online 集合) から提案を導くだけ。dismiss 管理は呼び出し側 (imperative shell)。
import { activeProfile, BUILTIN_SOURCE_ID, type Config, type Profile } from './config'

// 提案結果: 切替先 profile と、その根拠 (オンライン source 一致)。
// 提案が無いときは null (現 active が既に最適 / 候補が無い / 材料無し)。
export type ProfileSuggestion = {
  profileId: string
  profileName: string
  matchCount: number // オンライン source のうち候補 profile が有効化している数 (根拠表示用)
}

// profile の enabledSourceIds から builtin を除いた server source 集合。
// builtin は全 profile に必ず含まれ online 扱いなので、一致度判定では無視する (server だけで状況を識別)。
function enabledServerIds(p: Profile): Set<string> {
  return new Set(p.enabledSourceIds.filter((id) => id !== BUILTIN_SOURCE_ID))
}

// 候補スコア: オンライン集合に対する適合度。同点は後段の選好で割る。
//  - matched: profile が有効化していてオンラインな source 数 (多いほど良い)
//  - missing: profile が有効化しているがオフラインな source 数 (少ないほど良い = 余計を出さない)
//  - extra:   オンラインだが profile が有効化していない source 数 (少ないほど良い = 取りこぼし無し)
type MatchScore = { matched: number; missing: number; extra: number }

function scoreProfile(p: Profile, online: Set<string>): MatchScore {
  const enabled = enabledServerIds(p)
  let matched = 0
  let missing = 0
  for (const id of enabled) {
    if (online.has(id)) matched++
    else missing++
  }
  let extra = 0
  for (const id of online) if (!enabled.has(id)) extra++
  return { matched, missing, extra }
}

// a が b より良い候補か。優先順位: matched が多い > missing が少ない > extra が少ない。
// (オンラインを多く拾い、オフラインを抱えず、取りこぼしが少ない profile を最良とする。)
function isBetter(a: MatchScore, b: MatchScore): boolean {
  if (a.matched !== b.matched) return a.matched > b.matched
  if (a.missing !== b.missing) return a.missing < b.missing
  return a.extra < b.extra
}

// 現在オンラインな server source 集合 (onlineServerIds) に最も合致する profile を提案する。
//  - 提案は現 active と異なる profile に限る (同じなら切替不要 = null)。
//  - オンライン source が 1 つも無ければ提案しない (識別材料が無い)。
//  - 候補が現 active と「同等以上に良い」だけでは提案しない: 厳密に良い (isBetter) 候補のみ。
//    こうしないと "現状で十分" な場面でバナーがちらつく (DESIGN.md §4: 切替は手動を正とし提案は控えめに)。
//  - matched 0 (オンライン source を 1 つも拾えない profile) は提案しない (無関係な切替を促さない)。
export function suggestProfile(
  cfg: Config,
  onlineServerIds: ReadonlySet<string>,
): ProfileSuggestion | null {
  if (onlineServerIds.size === 0) return null
  const online = new Set(onlineServerIds)
  const active = activeProfile(cfg)
  const activeScore = scoreProfile(active, online)

  let best: { profile: Profile; score: MatchScore } | null = null
  for (const p of cfg.profiles) {
    if (p.id === active.id) continue
    const score = scoreProfile(p, online)
    if (score.matched === 0) continue // オンライン source を拾えない候補は除外
    if (!best || isBetter(score, best.score)) best = { profile: p, score }
  }
  if (!best) return null
  // 現 active より厳密に良い候補のときだけ提案する (同等なら現状維持)。
  if (!isBetter(best.score, activeScore)) return null
  return {
    profileId: best.profile.id,
    profileName: best.profile.name,
    matchCount: best.score.matched,
  }
}
