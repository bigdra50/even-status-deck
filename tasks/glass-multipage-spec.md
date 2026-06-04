# グラス マルチページ仕様: 意図的な複数ダッシュボード (RuntimePage)

状態: ドラフト (実装前)。
本書は会話 + codex(gpt5.5) 2往復の設計議論を統合した実装仕様。
方向は「意図的マルチページ・ダッシュボード」(ユーザーが page1/page2/page3 を明示設計、scroll でページ切替) に決定。

## 1. 背景・現状

グラス(G2 576×288)は常に「1ページ = 1 TextContainer(全面)・最大10行(`MAX_ROWS=10`)・ASCII系のみ」。
現状のナビは `views: GView[] = [summary, detail(groupA), detail(groupB), …]` を scroll で巡回する。

- summary: 有効ソース×有効segmentを各ソース1行に圧縮 (`summarySections`)。
- detail: 1 group の全 segment を progress bar 表示 (`detailBody`、`━`/`─`)。
- scroll up/down = `cycle()` で `idx` 巡回 / single tap = `idx=0` / double tap = `shutDownPageContainer(1)`=終了。
- 1ビューが10行超 → `clampRows` で「先頭9行 + "… +N more"」に畳み**溢れは捨てる**(続きは見られない)。
- 通常ビュー更新は topology が "single" のまま content 差し替え = `textContainerUpgrade` = **ちらつき無し**。

問題: 10行に収まらない情報を「捨てる」しかなく、目的別のダッシュボードを複数枚持てない。

## 2. SDK 制約 (Even Hub SDK 0.0.10, 実測)

- 「ページ」= 最大12コンテナ(text≤8/image≤4/list)の1セット。`containerTotalNum` は**ページ内コンテナ数**でありページ数ではない。
- ネイティブのページスタック/戻る/ページ送りイベントは**無い**。ページ切替は `rebuildPageContainer` で全差し替え(topology が変わると**ちらつきあり**)。
- TextContainer に scroll は**無い**(x/y/w/h+content のみ)。
- 使えるタッチ入力は `CLICK` / `SCROLL_TOP` / `SCROLL_BOTTOM` / `DOUBLE_CLICK` の4種のみ。
- ListContainer はネイティブscrollありだが「1ページ1個・`isEventCapture`無し・実機PoCで描画失敗→ボツ」。

含意: ページはアプリが自前管理する。各ページが「全面 TextContainer 1個」である限り、ページ切替は **content 差し替え (`textContainerUpgrade`) で実現でき、ちらつきが出ない**。既存の views/scroll/upgrade 機構がそのまま土台になる。

## 3. 設計モデル (確定)

現行の `views` を **`RuntimePage[]`** に一般化し、ナビ規約を「scroll = ランタイムページ巡回」で一本化する。
`view.pages` の有無で「デッキの中身」だけが切り替わり、操作・描画経路は変わらない。

```
view.pages 未設定 = auto デッキ (現行どおり・後方互換)
   [ summary ] → [ detail: groupA ] → [ detail: groupB ] → (wrap)

view.pages 設定済 = explicit デッキ (意図的マルチページ)
   [ page 1 ] → [ page 2 ] → [ page 3 ] → (wrap)
     時計/電池    開発         天気

  scroll↓/↑ = 次/前ページ   single tap = 先頭へ   double tap = 終了
  各ページ = 全面 TextContainer 1個 → content 差し替え (ちらつき無し)
```

### 3.1 RuntimePage (描画時の仮想ページ)

```ts
type RuntimePage =
  | { kind: 'autoSummary' }
  | { kind: 'autoDetail'; ref: GroupRef }
  | { kind: 'custom'; page: GlassPage }
```

- auto デッキの summary / detail は**render-time の仮想ページ**であり永続化しない。
  - 理由: 永続化すると group 追加削除 / visibility / status 欠落で page id・ページ数が揺れる。
- explicit デッキ (custom) は `view.pages` のユーザー定義をそのまま使う。
- **混在しない**: custom pages がある profile では auto detail 仮想ページを出さない(ユーザーが見たい bar は各ページに自分で配置する)。

### 3.2 デッキ構築 (buildViews の一般化)

```ts
function buildRuntimePages(d: GlassData, visible: VisibleMap): RuntimePage[] {
  const view = activeView(d.config)
  const custom = view.pages?.filter((p) => hasRenderableLayout(p.layout, d, visible))
  if (custom?.length) return custom.map((page) => ({ kind: 'custom', page }))
  // auto デッキ: summary + 描画可能な group ごとの detail (= 現行 buildViews と同じ判定)
  return [
    { kind: 'autoSummary' },
    ...renderableGroupRefs(d, visible).map((ref) => ({ kind: 'autoDetail', ref })),
  ]
}
```

- 空ページ(show-when 条件で全 chip が消えたページ)は巡回からスキップ(`filter`)。
- 全ページが空なら fallback 1ページ(現行 `(no metric)` 相当)を出す。

## 4. データモデル

`ProfileView` を additive 拡張する。

```ts
export type GlassPage = {
  id: string            // 安定 id (複製/並べ替え/インジケータ用)
  name: string          // ユーザー命名 (companion 表示用。グラスには既定で出さない)
  layout: GlassLayout   // 既存の 10 行スロット (rows[10] + customLabels)
}

export type ProfileView = {
  groups: Record<string, Record<string, ViewGroup>> // 可視性 = 全ページ共有 (変更なし)
  groupOrder: GroupRef[]                              // auto デッキ専用 (変更なし)
  glassLayout?: GlassLayout                           // legacy (移行で pages[0] へ。読込互換のため一時保持)
  pages?: GlassPage[]                                 // 追加: explicit デッキ
}
```

決定事項:
- 可視性(`groups{}`)は**全ページ共有**。「この profile が表示するデータ」は profile 単位、ページは「その置き場」。
- `groupOrder` は auto デッキ専用のまま。custom は各ページが自前 `rows[]` を持つので不要。
- ページ単位の固有設定(可視性・条件)は持たせない (YAGNI)。必要になったら後追い。

## 5. ナビゲーション

| 入力 | 挙動 |
|------|------|
| scroll ↓ (`SCROLL_BOTTOM`) | 次ページ (末尾→先頭へ wrap) |
| scroll ↑ (`SCROLL_TOP`) | 前ページ (先頭→末尾へ wrap) |
| single tap (`CLICK`) | 先頭ページ (index 0) へ |
| double tap (`DOUBLE_CLICK`) | アプリ終了 (`shutDownPageContainer(1)`) |

- ランタイムページが1枚なら scroll は no-op。
- overlay(通知/dialog) アクティブ時は現行どおり overlay が scroll/tap を消費 (変更なし)。
- `idx >= pages.length` になったら 0 に丸める (現行 `onStoreUpdate`/`onConfigChanged` と同じ)。

## 6. ページインジケータ (確定: ドットバー)

複数ページのとき、**最終行に中央寄せのドットバー**を出す。現在ページ=`●`、他=`○`。

```
[ 本文 9 行 ]
            ○ ● ○        ← 10 行目 (page 2/3)
```

- 表示条件: ランタイムページ > 1 のときだけ出す(1枚なら本文10行フル)。
- 本文予算: インジケータ表示時は `MAX_ROWS-1 = 9` 行、非表示時は 10 行。
- 同一 TextContainer 内の1行なので **topology 不変 = ちらつき無し**(別コンテナにはしない)。
- グリフ: `●`(U+25CF) / `○`(U+25CB)。progress bar の `━`/`─` 同様に幾何グリフは実機描画実績あり。実機で tofu なら `i/N` テキスト or `=`/`-` にフォールバック(要実機確認)。
- ドット数上限: ページが多い(目安 >8)場合はドット列が溢れるため `2/5` のテキスト表記へ自動フォールバック。
- 適用範囲: auto デッキ / explicit デッキ 両方に一律適用(規約を割らない)。
  - 注意(トレードオフ): auto デッキでも group が1つでもあれば summary+detail で2枚以上になり、summary 本文が9行に減る。許容できなければ「auto はインジケータ非表示」を後追いオプションにする(下記 9 の open question)。

## 7. レンダリング/性能

- 各ページ = 単一全面 TextContainer。ページ切替は content 差し替え = `textContainerUpgrade`。topology は "single" 固定で**ちらつき無し**。
- scroll 連打は coalesce: `desiredPageIndex` を更新し、送信中は待って**最新ページのみ**送る(既存の `refreshBusy`/`refreshPending` 直列化をそのまま流用)。
- `rebuildPageContainer` が要るのは将来 image/grid/list ページを混ぜる場合のみ。テキスト専用の本仕様では不要。

## 8. 後方互換 / 移行

- additive migration: `view.glassLayout` があり `view.pages` が無ければ `pages = [{ id:'page-1', name:'Page 1', layout: glassLayout }]` を生成。
- `CONFIG_VERSION` を 4 → 5 に上げる。読込時は legacy fallback を維持(`resolvePages`: `pages?` 優先、無ければ `glassLayout` を1枚として解決)。
- `glassLayout` は当面残す(読込互換)。保存を pages 主体に寄せた後、次バージョンで落とすか判断。
- 既存の additive migration 群(ensureBuiltin / normalizeVisibility / normalizeGlassLayout / pruneOrphans / cloneProfileView 等)は維持。`pages[].layout` も `normalizeGlassLayout` / `pruneOrphans` / deep copy の対象に拡張する。

### 挙動が変わる点 (要周知)
custom layout を作った profile では「scroll で group の bar detail を見る」既存挙動が無くなる(見たい bar は各ページに自分で配置)。
auto のままの profile は完全に現状維持。

## 9. companion UI (次フェーズで詳細化)

既存の Glass セクション(`renderGlassSection` / `renderGlassEdit` / fullscreen beta)を土台に、ページ管理を足す。

- ページ一覧(順序 = scroll 順)。各ページ: 名前 / サムネ(プレビュー) / 並べ替え(drag) / 複製 / 削除。
- 「ページ追加」→ 空 or 複製で新ページ。
- ページ選択 → そのページの 10 行レイアウトを既存 WYSIWYG エディタで編集。
- auto(pages 未設定)から「最初のページを作る」導線 = 現行 `layout-customize` を pages[0] 生成に接続。

## 10. 実装アウトライン (着手時の対象)

- `src/config.ts`: `GlassPage` 型 / `ProfileView.pages` 追加 / `CONFIG_VERSION=5` / migration(`glassLayout`→`pages[0]`) / `resolvePages` / `normalize`・`pruneOrphans`・`cloneProfileView` を pages 対応。
- `src/glass-render.ts`: `RuntimePage` 型 / `buildRuntimePages`(buildViews を一般化) / `renderRuntimePage`(autoSummary/autoDetail/custom 分岐) / インジケータ行合成(本文9行+ドットバー)。
- `src/glass.ts`: `views`→ランタイムページ列に置換。`cycle`/`onEvent`(scroll/tap) を `buildRuntimePages` ベースに。coalesce は既存直列化を流用。
- `src/companion.ts`: ページ管理 UI(9 章)。
- テスト: `buildRuntimePages`(auto/custom 分岐・空スキップ・fallback)、migration(glassLayout→pages[0])、インジケータ(>1 のとき9行+ドット / 1枚のとき10行)、ナビ(wrap/tap/空スキップ)。e2e(companion ページ管理 UI)。

## 11. Open questions (後追い)

- auto デッキのインジケータを非表示にするオプション(summary を常に10行フルにしたい場合)。
- ページ数の上限(UX/性能・現状 SDK 制約は無いが過剰は混乱)。
- ページ名のグラス表示(ドットバーの代わりに「DEV 2/3」テキストを選べるようにするか)。
- custom pages と auto detail の任意併存(現状は不可で確定。要望が出たら再検討)。
