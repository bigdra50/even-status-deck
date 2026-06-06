// companion 全体で共有する可変 UI 状態 (ctx)。分割後の各モジュールはここだけを読み書きし、
// index.ts を import しない (dependency-cruiser no-circular を構造的に満たす)。
// 規律: `const { config } = ctx` の分割代入と、モジュールスコープでの `const c = ctx.config`
// キャッシュは禁止。await を挟んだら必ず ctx.* を読み直す (途中で config が置換されうる)。
// 単一モジュールに閉じる状態 (debug/fs/swipe/sortable 等) はここに置かず所有モジュールに残す。
import { type Config, emptyConfig } from '../config'
import type { MachineInfo } from '../data'
import type { ProfileSuggestion } from '../suggest'

// companion (スマホ WebView) の画面。source-detail: 新 IA のドリルダウン先
// (その source の group/segment 設定。flat Items を置換)。
export type CompanionScreen =
  | 'home'
  | 'source-detail'
  | 'source-edit'
  | 'sources'
  | 'add-source'
  | 'places'

export const ctx = {
  view: 'home' as CompanionScreen,
  // source-detail で表示中の source id。
  detailSourceId: null as string | null,
  // source-edit から戻る先 (Sources 一覧経由か / Home への新規追加経由か)
  sourceEditBack: 'home' as 'home' | 'sources' | 'source-detail',
  editingSourceId: null as string | null,
  editMachine: null as MachineInfo | null, // 接続テストの検出結果
  config: emptyConfig() as Config,
  root: null as HTMLElement | null,

  // 接続テスト状態
  testState: 'idle' as 'idle' | 'testing' | 'ok' | 'error',
  testError: '',
  testUrl: '',

  // glass layout の編集モード (GLASS PREVIEW を WYSIWYG 編集面にする / 普段は view)。
  layoutEditing: false,
  // explicit デッキ編集中の対象ページ index (pages[pageEditingIdx])。profile 跨ぎでリセット。
  pageEditingIdx: 0,

  // ── Phase 4: プリセット切替の提案 (接続検出ベース。自動適用はしない) ──
  // このセッション中に却下した提案 profileId。一度 dismiss した profile は同セッションで再提示しない。
  dismissedSuggestions: new Set<string>(),
  // 現在表示中の提案 (無ければ null)。store の health 変化で再計算し、変化したときだけ Home を再描画する。
  currentSuggestion: null as ProfileSuggestion | null,

  // #43 ジオフェンス自動切替で最後に入った place (flapping/手動操作の上書き防止に使う)。
  lastGeofencePlace: null as string | null,
}
