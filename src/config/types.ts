import type { ImuConfig } from '../imu'
import type { VisibilityCond } from '../visibility/keys'

export type SourceKind = 'builtin' | 'server' | 'client'
// 表示オプション値のバッグ (#36)。キー = OptionField.id、値はプリミティブのみ。
// 宣言 (OptionField) と解決/書込ロジックは src/options.ts が所有する。config はここに永続型だけ置き、
// options.ts を import しない (config ↔ options の循環依存を作らない)。
export type OptionValues = Record<string, string | number | boolean>
// urls: 複数経路 (LAN / VPN 等。到達順に試行、先頭優先)。MVP では urls を正とし、旧 url? は
//   後方互換で読み migrate で urls[0] へ正規化する。machineId: 同一マシン判定キー (Phase 3 で採用)。
// options: source 単位の表示オプション (単位/粒度 等。素材 = 全 profile 共有)。
export type SourceDef = {
  id: string
  kind: SourceKind
  label: string
  url?: string // 後方互換 (読込専用)。新規書込は urls を使う
  urls: string[]
  machineId?: string
  options?: OptionValues
  // displayOwner: 表示用オーナー (例 'Glass' / 'Mac')。同系統データ衝突時に owner バッジ/prefix で
  // 出自を区別する (tasks/display-model-spec.md)。Phase1 は型のみ (builtin g2 のみ seed)、
  // 消費 (バッジ/displayLabel 焼込) は Phase2/3。
  displayOwner?: string
  // origin: source の出自。'app_bundled' = アプリ同梱(builtin Device / 統合 Location)、
  // 'user_added' = ユーザーが追加(server / 将来の外部 client provider)。未設定は user_added 相当。
  // companion の Home セクション分け(Included / Connected / 将来 Extensions)が kind と併せて読む。
  origin?: 'app_bundled' | 'user_added'
}

// ── 素材 (共有資産) ──
// metric の素性のみを持つ。format: clock segment の表示フォーマット (例 'HH:mm')、未設定はロケール既定。
// visibility: 閾値/onChange 表示条件。表示系 (enabled/align 等) は profile.view へ分離する。
// options: segment 単位の表示オプション (#36。clock は後方互換で format に合成するため options を使わない)。
export type SegMeta = {
  id: string
  format?: string
  options?: OptionValues
  visibility?: VisibilityCond
  // 表示 identity (tasks/display-model-spec.md)。素材 = profile 非依存。
  // category: device_class ベースの leaf 語彙 (例 'battery' / 'temperature')。新規 segment は sync 時に
  //   defaultCategory で seed、既存は migrate で backfill。「種類」軸として整列/衝突判定に使う。
  // displayLabel: 衝突時に焼き込む静的ラベル (Phase3 で glass が読む)。Phase1 は書かない。
  // tags: 横断フィルタ/preset 自動化の裏軸 (多対多・任意)。Phase1 は型と sanitize のみ (producer 出力なし)。
  category?: string
  displayLabel?: string
  tags?: string[]
}
// 素材の group メタ。displayName: ユーザーが付けた group 表示名 (リネーム。見出しと merge 判定を上書き)。
// lastLabel: 最後に観測した live group label の内部記録 (sync で捕捉)。同 source 内で見出しが一致する
// group は glass で 1 unit にマージ表示するため、offline でも unit 構成/align が揺れない merge identity
// として使う (UI には出さない)。effective 見出し = displayName || lastLabel || liveLabel。
// 旧 displayNameSource ('auto'=衝突自動命名 'Claude (limits)' 世代) は廃止 — migrate で一掃する。
export type GroupMeta = {
  segments: SegMeta[]
  displayName?: string
  lastLabel?: string
}

export type GAlign = 'top' | 'bottom'
export type GroupRef = { sourceId: string; groupId: string }

// ── レシピ (profile 固有) ──
// ViewGroup: profile ごとの可視性・展開・寄せ・group ラベル前置と segment 可視性 (segId -> boolean)。
// align: glass summary での縦寄せ。未指定は 'top'。
// showDefaultLabel: glass で各 segment の前に group ラベル (G2/Claude 等) を出すか (未指定 clock=false/他=true)。
export type ViewGroup = {
  enabled: boolean
  expanded?: boolean
  align?: GAlign
  showDefaultLabel?: boolean
  segments: Record<string, boolean>
}

// glass の行レイアウト (表示レシピ)。group (素材) とは独立した固定 MAX_ROWS 行スロット。
// rows[i] = i 行目の segKey 並び (空行可)。どの行にも無い enabled segment は companion の
// Unplaced 棚に自動表示。未設定 (undefined) の間は従来の group=1行 自動描画。
export type GlassLayout = {
  rows: string[][] // rows.length === MAX_ROWS。各要素 = key (segKey / @label / @customLabel:id)
  customLabels: Record<string, { text: string }> // ユーザー定義ラベルの本文 (id -> text)
}

// grid ページ (Issue #17) の 1 セル。12×10 grid 上の矩形に segment を束縛する。
// rows = セル内の行スロット (GlassLayout.rows と同語彙: segKey / @right / @customLabel:id。
// custom label の本文は page.layout.customLabels を共有する)。
// border は rowSpan>=2 のみ有効 (1 行セルは枠線が line-height 27px を圧迫する。normalize が落とす)。
export type GridCellSpec = {
  id: string
  col: number
  row: number
  colSpan: number
  rowSpan: number
  border?: number // 0-5
  radius?: number // 0-10
  padding?: number
  rows: string[][]
}
export type GlassGrid = { cells: GridCellSpec[] }

// 意図的マルチページ (explicit デッキ) の 1 ページ。layout = そのページの 10 行スロット。
// id: 安定 id (複製/並べ替え/インジケータ用)。name: companion 表示用 (グラスには既定で出さない)。
// mode: 表示系 reader の分岐軸 (未設定 = linear)。'grid' のとき grid を描画し、layout は
// grid 化直前の凍結スナップショットとして保持する (旧バージョンへの downgrade 時は layout に戻る。
// 自動投影はしない)。prune / source remap 系の visitor は layout と grid の両方を更新する。
export type GlassPage = {
  id: string
  name: string
  layout: GlassLayout
  mode?: 'linear' | 'grid'
  grid?: GlassGrid
}

// profile の view (レシピ)。可視性・並び・10 行配置を状況ごとに持つ。
export type ProfileView = {
  groups: Record<string, Record<string, ViewGroup>> // sourceId -> groupId -> ViewGroup
  groupOrder: GroupRef[] // 全ソース横断の表示順
  glassLayout?: GlassLayout // legacy: 未設定なら group=1行 自動描画。pages 移行後は読込互換で残す
  pages?: GlassPage[] // explicit デッキ (意図的マルチページ)。未設定 = auto デッキ or glassLayout 1 枚
}

// profile = 状況セット。enabledSourceIds は fetch/表示する source の範囲。
export type Profile = {
  id: string
  name: string
  enabledSourceIds: string[]
  view: ProfileView
}

// 削除した source の表示レシピ snapshot (machineId 別)。Phase 3: 同一マシン再追加で
// profile の可視性/並び/glassLayout を復元する tombstone。profileId -> その profile の view 断片 + enabled。
// machineId をキーにし sourceId はキーにしない (id 生成規則を将来変えても復元できる)。
export type RemovedSourceView = {
  enabled: boolean // 削除前に enabledSourceIds に含まれていたか (fetch 範囲の復元)
  groups: Record<string, ViewGroup> // groupId -> ViewGroup (可視性/展開/寄せ/segment 可視性)
  groupRefs: string[] // groupOrder に含まれていた groupId 群 (順序復元用)
  glassRows: Record<string, string[][]> | null // 旧 sourceId|grp|seg を含む glass 行 (再 key 用に旧 sourceId も保持)
}
export type RemovedView = {
  at: number // 削除時刻 (古い tombstone を間引く)
  oldSourceId: string // 削除時の id (glass row の旧 segKey を新 id へ remap する用)
  profiles: Record<string, RemovedSourceView> // profileId -> view 断片
}

// IMU 方向検出は src/imu ライブラリが所有。Config は enable + キャリブの永続先として imu? を持つ。
// recentlyRemoved: 削除済み source の表示レシピ tombstone (machineId -> snapshot)。additive optional。
export type Config = {
  version: number
  sources: SourceDef[]
  groups: Record<string, Record<string, GroupMeta>> // sourceId -> groupId -> 素材 (segment 素性のみ)
  profiles: Profile[]
  activeProfileId: string
  imu?: ImuConfig
  recentlyRemoved?: Record<string, RemovedView>
}
