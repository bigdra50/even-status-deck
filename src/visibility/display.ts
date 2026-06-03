// 条件成立 → overlay UI 提示の Imperative Shell (glass 専用)。companion preview は使わない。
//
// 発火モデル:
//   toast / notification / dialog = edge。条件 truth が known-false → known-true の瞬間に 1 回発火。
//   banner                        = level。known-true の候補を active view 順で先勝ち表示し、解消で clear。
//
// 正しさのための規約 (codex GPT-5.5 と確定):
//   - 発火判定は truthMap (strict tri-state)。fail-open の VisibleMap は使わない (na で誤発火するため)。
//   - unknown (offline/評価不能) は edge を再アームしない & 前回 known 値を温存する (再接続で誤再発火しない)。
//   - seed(init/config 変更) は edge を発火させない (起動時の通知ストーム防止)。banner は level なので seed で表示可。
//   - edge は per-key cooldown と 1 observe あたりの発火数上限で連発を抑える。
//   - 対象は enabled な source/group/segment のみ。
//   - 文言は glass shell が live status から解決する (collector は segRef を返すだけ)。
import { activeView, BUILTIN_SOURCE_ID, type Config, enabledSources } from '../config'
import { type CondDisplay, type ConditionTruth, type ConditionTruthMap, segKey } from './keys'

const EDGE_COOLDOWN_MS = 30_000 // 同一 key の最小再発火間隔 (toast/notification/dialog)

export type DisplayFire = {
  ui: 'toast' | 'notification' | 'dialog'
  sourceId: string
  groupId: string
  segId: string
  text?: string // カスタム文言 (config.display.text)。省略時は glass が "label value" を自動合成
}
// banner は 1 行スロット。set=この segment を表示 / clear=条件 banner を消す / none=スロットに触れない
// (none は server 由来 banner を温存するため)。
export type DisplayBanner =
  | { kind: 'set'; sourceId: string; groupId: string; segId: string; text?: string }
  | { kind: 'clear' }
  | { kind: 'none' }
export type DisplayResult = { fires: DisplayFire[]; banner: DisplayBanner }

export type ConditionDisplayRuntime = {
  // init / config 変更時。edge を発火させずに状態を seed する (banner は level なので表示し得る)。
  seed(config: Config, truthMap: ConditionTruthMap): DisplayResult
  // store 更新時。edge 発火 + banner を算出する。
  observe(config: Config, truthMap: ConditionTruthMap, now?: number): DisplayResult
  // banner を tap で消したとき。現在の banner key を「known-false になるまで」抑止する。
  dismissBanner(): void
  // cleanup 用。全状態を破棄する。
  reset(): void
}

type Candidate = {
  key: string
  sourceId: string
  groupId: string
  segId: string
  ui: CondDisplay['ui']
  text?: string
  truth: ConditionTruth
}

// active view 順に display 指定の候補を集める (enabled のみ)。先頭が banner の先勝ち基準になる。
function collectDisplayCandidates(config: Config, truthMap: ConditionTruthMap): Candidate[] {
  const view = activeView(config)
  const enabledSrc = new Set(enabledSources(config).map((s) => s.id))
  const out: Candidate[] = []
  for (const ref of view.groupOrder) {
    if (ref.sourceId !== BUILTIN_SOURCE_ID && !enabledSrc.has(ref.sourceId)) continue
    const vg = view.groups[ref.sourceId]?.[ref.groupId]
    if (!vg?.enabled) continue
    const meta = config.groups[ref.sourceId]?.[ref.groupId]
    if (!meta) continue
    for (const sm of meta.segments) {
      const disp = sm.visibility?.display
      if (!disp) continue
      if (vg.segments[sm.id] === false) continue // segment 無効
      const key = segKey(ref.sourceId, ref.groupId, sm.id)
      out.push({
        key,
        sourceId: ref.sourceId,
        groupId: ref.groupId,
        segId: sm.id,
        ui: disp.ui,
        text: disp.text,
        truth: truthMap.get(key) ?? 'unknown',
      })
    }
  }
  return out
}

export function createConditionDisplayRuntime(): ConditionDisplayRuntime {
  const edgeState = new Map<string, boolean>() // 最後に観測した known truth。unknown では更新しない (温存)
  const lastFiredAt = new Map<string, number>() // key -> 最終発火時刻 (cooldown)
  const bannerDismissed = new Set<string>() // tap で消した banner key (known-false で解除)
  let ownedBanner: string | null = null // 現在 condition が占有している banner の key

  function evalEdges(cands: Candidate[], now: number, fire: boolean): DisplayFire[] {
    const fires: DisplayFire[] = []
    for (const c of cands) {
      if (c.ui === 'banner') continue
      if (c.truth === 'unknown') continue // 温存: edgeState を触らない・発火しない
      const prev = edgeState.get(c.key)
      // strict: 確定 false → 確定 true のみ。prev 未観測(undefined)は arm のみで発火しない
      // (起動/接続直後に既に true でも撃たない = storm 防止。サーモスタット的に「跨いだ瞬間」に鳴る)。
      const rising = prev === false && c.truth === true
      // 発火数の上限は設けない: per-key cooldown と overlay queue 上限が表示量を律速する。
      // ここで上限を設けると edge を落として次 observe で再評価されず取りこぼす事故になる。
      if (fire && rising) {
        const last = lastFiredAt.get(c.key) ?? Number.NEGATIVE_INFINITY
        if (now - last >= EDGE_COOLDOWN_MS) {
          fires.push({
            ui: c.ui,
            sourceId: c.sourceId,
            groupId: c.groupId,
            segId: c.segId,
            text: c.text,
          })
          lastFiredAt.set(c.key, now)
        }
      }
      edgeState.set(c.key, c.truth) // seed/observe 共通で known 値を記録
    }
    return fires
  }

  function evalBanner(cands: Candidate[]): DisplayBanner {
    // known-false になった banner は dismiss を解除 (再アーム)。unknown では解除しない。
    for (const c of cands) {
      if (c.ui === 'banner' && c.truth === false) bannerDismissed.delete(c.key)
    }
    const winner = cands.find(
      (c) => c.ui === 'banner' && c.truth === true && !bannerDismissed.has(c.key),
    )
    if (winner) {
      ownedBanner = winner.key
      return {
        kind: 'set',
        sourceId: winner.sourceId,
        groupId: winner.groupId,
        segId: winner.segId,
        text: winner.text,
      }
    }
    if (ownedBanner !== null) {
      ownedBanner = null
      return { kind: 'clear' } // 占有していた banner を解放
    }
    return { kind: 'none' } // 条件 banner を持っていない → スロットに触れない (server banner を温存)
  }

  function evaluate(
    config: Config,
    truthMap: ConditionTruthMap,
    now: number,
    fire: boolean,
  ): DisplayResult {
    const cands = collectDisplayCandidates(config, truthMap)
    const fires = evalEdges(cands, now, fire)
    const banner = evalBanner(cands)
    return { fires, banner }
  }

  return {
    seed: (config, truthMap) => evaluate(config, truthMap, 0, false),
    observe: (config, truthMap, now = Date.now()) => evaluate(config, truthMap, now, true),
    dismissBanner: () => {
      if (ownedBanner !== null) bannerDismissed.add(ownedBanner)
    },
    reset: () => {
      edgeState.clear()
      lastFiredAt.clear()
      bannerDismissed.clear()
      ownedBanner = null
    },
  }
}
