# 設計仕様: 条件成立時の表示 UI 選択 (condition → display UI)

status: 設計のみ確定（実装保留）/ 2026-06-03 / CONFIG_VERSION bump なし方針

## 背景・スコープ

直前に visibility leaves（threshold/onChange/present/inPlace、AND/OR、self/同group peer）を ship した。
これは「条件成立時に inline 行を常時表示」する gating。

今回の追加: 条件成立時に、実装済みの overlay UI のいずれかを「選択して」提示できるようにする。
当初 "Toast" と言っていたが、実体は「実装済み UI のどれかを選ぶ」形。

確定済みのユーザー判断:

- 提示方法は実装済み UI から選択する（Persistent を含むセレクタ）。
- Toast 文言は自動合成 + 任意カスタム。
- flapping throttle は v1 で入れる（per-key cooldown）。
- reload 跨ぎの取りこぼしは許容（seed-only）。
- 今回は設計のみ。実装は別途判断。

## 実装済み overlay UI 4 種（src/glass-overlay.ts, src/event-types.ts）

| kind | 見た目 | fields | 入力 | 消去 | 発火モデル | 優先度 |
|------|--------|--------|------|------|-----------|--------|
| notification | 中央カード・複数 stack（左ドット, max4） | app/sender/body | scroll+tap 消費 | 手動既読(tap) | edge(fire-once) | 2 |
| toast | 下端 1 行 | text(+durationMs) | 非消費 | 自動(既定3s, queue) | edge(fire-once) | 3(最低) |
| banner | 上 1 行常駐合成 | text | tap で消去可 | set/clear で保持 | level(条件中保持) | 別枠 |
| dialog | 中央 modal・blocking | title/message/actions[] | scroll+tap 消費 | tap で確定(onResult) | edge(fire-once) | 1(最高) |

優先度 dialog > notification > toast で 1 つを active 表示。banner は上行合成で別レイヤ（dialog 中は隠す）。
SDK に真の z-layer/アニメは無く、overlay は `rebuildPageContainer` で別コンテナ集合を送る即時切替で表現。

## 発火モデルの本質的区別: edge vs level

- 一過性（fire-once, rising edge）: toast / notification / dialog。条件が known-false → known-true になった瞬間に 1 回 emit。
- 常駐（level-triggered）: banner。条件が known-true の間 `setBanner`、known-false で `clearBanner`。
  これは既存の「inline 常時表示」の banner 版（上行に出す）。

## データモデル（additive, CONFIG_VERSION bump なし）

`VisibilityCond` にオプショナルな提示先を足す。absent = 現状の inline persistent（後方互換）。

```ts
// src/visibility/keys.ts
type CondDisplay = {
  ui: 'toast' | 'banner' | 'notification' | 'dialog'
  text?: string // 省略=自動合成("<label> <value>")。指定=カスタム文言(例 "Battery low!")
}
type VisibilityCond = {
  combinator: 'and' | 'or'
  conditions: VisibilityLeaf[]
  display?: CondDisplay // NEW。absent=inline persistent(現状)
}
```

- `display` 省略 = 今日の挙動（inline 行 gating）。既存 v4 config は無改変でロード。
- `display` 指定 = その UI で提示（inline 行は出さない＝提示は 1 つに集約。"選択する" のモデルに一致）。
- 命名: `display`（leaf kind の `present` と衝突回避）。
- 正規化（config.ts normalizeVisibility）: `outside`/`absent` と同じ true-only/既知 kind のみ通す流儀で carry。
  `conditions` 空 + `display` は無意味 → 正規化で除去・companion でも非表示。

## 評価・発火セマンティクス（codex GPT-5.5 の blocking fix 反映）

1. tri-state（最重要）: inline 表示の visibility map は fail-open（`na` → true＝迷ったら出す）。
   通知系 UI は known-false → known-true のみ発火し、`na`/`unknown` では発火しない。
   `VisibleMap` の boolean は流用不可。通知用に `true|false|unknown` を別途評価する。
2. runtime instance 分離: `createVisibilityRuntime()` 化。glass と companion preview で state/timer を分離する。
   現 singleton では preview の `computeVisible` が edge/onChange state を消費し glass が取りこぼす（既存 onChange にも潜在）。
3. cooldown/queue: per-key cooldown（例 30s）+ fires-per-tick cap + overlay queue 上限 + 同一 key coalesce + enqueue TTL。
   onChange leaf を含む条件は構造上「変化ごと」なので throttle は必須（defer 不可）。
4. offline = unknown: source 消失で map から key 欠落時は prev を unknown として温存し、再接続での誤再発火を防ぐ。
   破棄は config からの key 削除 / display 無効化のみ（`resetVisibility` 由来の cleanup を含む）。
5. seed-only: init / config 変更は seed（発火しない）。発火は glass の `onStoreUpdate` 経路のみ。
   明示 `seed()` / `observe()` API にして誤配線を防ぐ。config 変更中に offline だった場合、次の評価可能観測も
   seed にするため condition fingerprint または config revision を持つ。
6. enabled のみ対象: `computeVisibleMap` は profile の enabled を見ない（描画側は見る）。
   発火対象は実際に表示候補となる enabled segment に限定する。
7. text は shell で解決: collector は `segKey` を返し、glass shell が live status から文言合成。
   `Segment` に `displayLabel` は無い → `seg.label + ' ' + seg.value`、または display-model 経由で解決。
8. 同時成立順: active view の group / segment 順に発火順を固定する。
9. stale 防止: dialog/notification 表示中は toast 消化が止まる → 条件解消後の古い表示を防ぐため enqueue TTL を持つ。

## UI kind 別の考慮

- toast: そのまま。edge fire-once。当初案。
- banner: level。known-true で set / known-false で clear。複数条件が 1 行 banner を競合 → 優先 or 最新 or 連結を決める（open）。
- notification: edge fire-once、stack(max4)、手動既読。app=source label / sender=segment label / body=text|auto に自動マッピング。
- dialog: blocking + onResult 往復。in-app 条件では actions が何をするか未定義（host 待ち受けが無い）。
  ack-only に限定するか、action → preset 切替等のアクション束縛を定義する必要がある（open, v1 保留候補）。

## companion UI（スケッチ）

- segVisEditor の Show 行に「提示方法」セレクト: Persistent(既定) / Toast / Banner / Notification / Dialog。
- 任意カスタム文言の text 入力（省略時は自動合成）。
- `conditions` 空のときはセレクト非表示（提示は条件成立が前提）。
- ハンドラは `seg-vis-combinator` と同じく top-level case（`onSegVisChange`）で `vis.display` を mutate → saveConfig → render。

## v1 スコープ案

- 確実: toast / banner（セマンティクスが clean）。
- 次点: notification（手動既読 stack）。
- 保留: dialog（action 意味論の定義が要る）。
- 横断 fix（tri-state / runtime instance / cooldown / queue / offline=unknown / seed-only / enabled / 発火順）は v1 必須。
- 実装規模: 横断 fix 込みで概ね 1〜2 日。

## アーキテクチャ（不変条件）

```
visibility leaves (shipped)            NEW: display?: CondDisplay (orthogonal)
+-----------------------------+        +----------------------------------+
| computeVisibleMap (PURE)    |        | tri-state 評価(known/unknown)     |
|   -> inline 表示 map        |        |   + collectDisplayEdges (PURE)    |
+-----------------------------+        +-----------------+----------------+
   ^ companion preview も呼ぶ                            | glass-only
   |  (発火は絶対にしない=invariant)                     v
+--+--------------------------+   glass shell: edge/level -> overlay.toast/notify/dialog/setBanner
| createVisibilityRuntime()   |        -> 既存 overlay manager(優先度/queue/自動消去) を再利用
|  (glass/companion で分離)    |
+-----------------------------+
```

不変条件（コメント + テストで固定）: 発火ロジックを `computeVisible`/`computeVisibleMap` の内側へ移さない。
移すと companion preview が実機グラスへ通知を撃つ。

## 実装着手時に確認する open questions

1. v1 で含める kind（toast/banner/notification、dialog は保留?）。
2. banner 競合時の方針（優先 / 最新 / 連結）。
3. dialog の action 意味論（ack-only か、preset 切替等の束縛か）。
4. 提示の排他性: `display` 指定時に inline 行を完全に出さない（本仕様の既定）で良いか。
   banner は level なので inline 置換が自然。edge UI（toast 等）でも inline を出さない＝「通知専用」で良いか確認。

## 参照（file:line）

- src/glass-overlay.ts（4 UI の描画・優先度・queue・自動消去）
- src/event-types.ts:10（OverlayEventKind = notification|toast|banner|dialog）, :60-72（上限/既定）
- src/visibility/conditions.ts:31-37（combine の fail-open）, :46-89（computeVisibleMap）
- src/visibility/runtime.ts:12-47（singleton state / wakeAt / resetVisibility）
- src/glass.ts（onOverlayEvent ingress, computeVisible 呼び出し 3 箇所, cleanup）
- src/companion.ts:224（preview の computeVisible = 発火させてはならない経路）, segVisEditor / onSegVisChange
- src/config.ts:1102-1141（sanitizeLeaf / normalizeVisibility）
