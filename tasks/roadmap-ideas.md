# データソース & UI 拡張アイデア（ロードマップ）

built-in が薄いので増やす方針のアイデア帳。
グラスに乗る短い値（数値 / % / 時刻 / 状態 / バー）に絞る。長文（ニュース見出し等）は不向きなので除外。
キーはサーバー内に留め、グラスへは計算済みの値だけ送る（既存の信頼境界）。

3 層は配送方式に対応する。

```
            キー不要                                  キー入力
  ┌─────────────┬──────────────────────┬────────────────────────┐
  │ A 本体だけ   │ B 自前で無料          │ C APIキー               │
  │ client算出   │ server built-in       │ provider (key=server内) │
  └─────────────┴──────────────────────┴────────────────────────┘
        即実装        API検証して同梱         公式サンプル+ユーザ設定
```

## 採用方針・優先度

| 区分 | 状態 |
|---|---|
| B-1 気象（open-meteo） | 導入する（次の実装対象）|
| A 日付・暦 / 天文 / タイマー | 安価なので随時追加 |
| B-2〜B-4（金融 / OSS / 雑学）| 今後。採用前に各 API の keyless・無料枠・ToS・レート制限を検証 |
| C ユーザーキー系 | 今後。claude-usage provider と同形の公式サンプルを数個 |

実装方針: B-1 はまとめて 1 つの `weather` provider に集約。A は builtin local に group を複数追加。位置情報は config に緯度経度 or 都市で持たせる（自動 geolocation は iOS WebView 権限が不確実なので避ける）。

---

## A. 本体だけ（キー不要・サーバー不要・オフライン）

クライアント（WebView）算出。time/date/G2 電池に足す。

### A-1 日付・暦（純計算）
| 機能 | 表示例 |
|---|---|
| 年/月/日 経過バー | `2026 ▓▓▓▓░41%` |
| 週番号・四半期 | `W22 Q2` |
| 残り日数 | `月末2日` `年内215日` |
| カウントダウン（任意日）| `締切まで12日` |
| カウントアップ／連続日数 | `記念日43日` |
| 次の祝日まで（JP 祝日を内蔵）| `みどりの日 3日` |
| 営業日 | `今月 残14営業日` |
| 六曜 | `大安` |
| 二十四節気 | `立夏` / `小満まで4日` |

### A-2 天文（座標は config 手入力＝ネット不要の計算）
| 機能 | 表示例 |
|---|---|
| 月相・月齢 | `🌒 月齢4.2` |
| 日の出／日の入り | `🌅5:42 🌇18:30` |
| 昼の長さ・残り日照 | `昼13h28m` |

### A-3 タイマー・計測（開始操作）
| 機能 | 表示例 |
|---|---|
| ポモドーロ | `Focus 18:32` |
| ストップウォッチ／作業計測 | `作業 1:42:10` |
| 習慣ストリーク | `🔥7日` |

### A-4 デバイス・手動入力（companion でローカル保持）
| 機能 | 表示例 | 備考 |
|---|---|---|
| G2 電池＋残り推定 | `G2 72% ~5h` | 消耗レート（ロードマップ Phase A）を活用 |
| 接続状態 | `wifi` / `offline` | navigator.onLine（種別は Android のみ）|
| 手動カウンター | `水 5/8` | +/- で増減 |
| 目標バー | `貯金 ▓▓░65%` | 現在/目標を入力 |
| ピン留めテキスト | `🎯 集中` | 一言固定 |
| 当番ローテ | `ゴミ出し 今日` | 周期を設定 |

---

## B. 自前で無料（同梱・無料 keyless API をサーバー側で叩く）

サーバー側 fetch なので CORS 不問・ユーザーのキー入力なし。enable + 最小設定だけ。

### B-1 気象・環境（open-meteo＝無料・keyless・確実）★導入予定
| 機能 | 表示例 |
|---|---|
| 現在天気・気温 | `Tokyo 21°☀` |
| 最高／最低 | `21°/14°` |
| 降水確率・雨予報 | `☔60% 15時` |
| UV 指数 | `UV 7` |
| 空気質 AQI / PM2.5 | `AQI 42` |
| 風（速度・向き）| `風 4m S` |
| 気圧（傾向）| `1009hPa↓` |
| 波・海況（沿岸）| `波 1.2m` |

### B-2 金融（keyless 想定・要検証）
| 機能 | 表示例 | 候補ソース |
|---|---|---|
| 為替 | `USD/JPY 156.2` | frankfurter（ECB）|
| 暗号通貨 | `BTC $68.4k` | Binance public ticker |

### B-3 開発・OSS（GitHub は unauth 60/h/IP）
| 機能 | 表示例 |
|---|---|
| GitHub repo | `★1.2k v0.1.53` |
| 公開 issue/PR 数 | `issues 23` |
| npm 週間 DL | `dl 12.3k/w` |
| Docker pulls | `pulls 1.2M` |
| サービス稼働（公開 status）| `GitHub OK` |

### B-4 サイエンス・雑学（keyless・要検証・数値向き）
| 機能 | 表示例 | 候補ソース |
|---|---|---|
| 直近地震 | `M4.2 30分前` | USGS |
| 磁気嵐 Kp 指数 | `Kp 3` | NOAA SWPC |
| BTC 送金手数料 | `8 sat/vB` | mempool.space |
| 次の祝日（任意国）| `🇺🇸 7/4 35日` | Nager.Date |

---

## C. APIキーを入れてできること（private・リッチ／キーはサーバー内）

provider（subprocess / JS plugin / hosted）として配送。キーはサーバー内、グラスへは計算済みの値だけ。

| 機能 | 表示例 | 要 | 配送 |
|---|---|---|---|
| GitHub（自分）| `通知3 PR2 issue5` | PAT | provider |
| Google Calendar | `次の会議 25分` | OAuth | provider |
| Todoist / TickTick | `今日 残4` | token | subprocess |
| Home Assistant | `室温24° 電力0.8kW` | URL+token | subprocess |
| 株 / ポートフォリオ | `AAPL +1.2%` | 無料 key（Finnhub 等）| provider |
| Linear / Jira | `assigned 7` | token | provider |
| Oura / Fitbit | `Sleep87 Steps8.2k` | token | provider / iPhone bridge |

---

## UI 拡張アイデア: セル / Widget グリッド（構想）

ジャストアイデア。グラス画面を「セル単位」で扱い、配置をカスタムできるようにする。

### 現状
glass は status line 1 本（~10 行）。group を線形順に並べ、超過分は `+N more` に畳む。配置は ON/OFF とドラッグ並べ替えのみ（companion）。

### 構想
画面をグリッド（例: 列 × 行のセル）として扱い、各 widget が複数セルを占有できる（`1x1` / `2x1` / `2x2` …）。スマホのホーム画面 / Stream Deck / macOS ウィジェットのような空間レイアウト。

- `2x2` を使う widget なら、ミニチャート・大きな数値 + ラベル + バー・天気（アイコン + 気温 + 最高最低）など、status line 1 行より表現を増やせる。
- 線形リストでなく空間配置にできるので、視線移動や優先度づけがしやすい。

### 論点（要検討）
- キャンバスが小さい（576×288 / 4-bit 緑単色）。セルの粒度・最小サイズ・文字可読性をどう取るか。
- 入力: companion でグリッドに widget をドラッグ配置する UI。
- レンダリング: `glass-render.ts` は現状リニア。グリッド用のレイアウトエンジンが要る。
- プロトコル: `StatusDoc` の group/segment に「希望サイズ・形」のヒントを持たせる拡張が要る（後方互換を保ちつつ）。
- glanceability: 情報を詰めすぎない。2x2 は「1 つのことを大きく」が基本。

### SDK 制約を踏まえた実現性（glasses-ui 確定仕様）
- 各 widget = 座標配置した Text/Image コンテナ。`borderWidth + borderRadius + paddingLength` でセル枠、Unicode ブロック（`━`/`─`）でバー。**グリッドは座標で自由に組める**。
- 上限がそのままレイアウト上限: 1 ページ最大 **12 コンテナ（text/list 8 + image 4）**。4 セルを全部 bordered text にしても 8 まで、画像セルは 4 まで。
- 画像セル（ミニチャート/アイコン）は 1 枚 ~0.5–2s/BLE で重い → 画像は最小限、基本はテキストセル。
- 配置（レイアウト）変更は `rebuildPageContainer`（ちらつき）。なので**セル枠は固定し、中身だけ `textContainerUpgrade` で更新**する設計が良い（ちらつき無し）。
- フォントサイズ/色/整列の制御は無い（左寄せ固定）。`2x2` の「大きく見せる」は文字数・罫線・画像で表現する。

### 段階案（グリッド確定後）
1. 現状の線形 status line を「12×10 グリッドの 1 プリセット（全面 text cell に summary 束縛）」として再定義（描画結果は不変）。
2. compiler（layout → container[]）を実装し、複数 text cell を配置可能に（image はまだ）。
3. image cell（client 描画: weather icon / sparkline）を追加。
4. companion にグリッド配置エディタ（ドラッグ + span、上限/重なりを弾く）。

詳細は下記「グリッドレイアウト設計（確定方針）」。

---

## グリッドレイアウト設計（確定方針）

グラス表示を「12×10 グリッド上にセルを自由配置」できるようにする。`layout 定義 → compiler → SDK container[]` の決定的変換。gpt-5.5 と詰めた確定方針（2026-05-30）。

### グリッド
- MVP は固定 `cols=12, rows=10`（スキーマ上は可変、当面固定）。1 セル = 48 × 28.8px。
- 縦 10 行は text の line-height 27px に対応。image 最大 288×144 = ちょうど `6×5` セル。
- gap/gutter は MVP `gap=0`（将来 `gapX/gapY`）。

### スキーマ
```ts
type GlassLayout = {
  cols: number   // MVP 12
  rows: number   // MVP 10
  cells: Cell[]
}

type Cell = {
  id: string                       // 安定 ID（grid 変更時の再配置 / 差分キー）
  col: number; row: number         // 左上（0-based）
  colSpan: number; rowSpan: number
} & (TextCell | ImageCell)

type TextCell = {
  type: 'text'
  bind: SegmentRef[]               // groupId/segmentId を N 行表示（既存 segment モデル流用）
  maxLines?: number
  overflow?: 'ellipsis' | 'clip'   // 既定 ellipsis
  border?: number                  // 既定 0（下記の注意）
  padding?: number                 // 既定 0
}

type ImageCell = {
  type: 'image'
  bind: ImageSource                // client 描画（下記）
}

type ImageSource =
  | { kind: 'icon'; from: string }          // 例: weatherCode → アイコン
  | { kind: 'sparkline'; ref: SegmentRef }  // segment 履歴の折れ線
  | { kind: 'bitmap'; asset: string }       // ローカルアセット
```

### compiler（layout → container[]、決定的）
1. validate: bounds（grid 内）/ overlap（セル占有の重なり禁止）/ 上限（**user text ≤7・image ≤4・total ≤12**）。違反は **配置時に拒否**（描画時の `+N more` 救済はしない）。
2. rect: grid → px（`col*48` / `row*28.8` / `span*…`）。
3. image validate: `20×20 ≤ size ≤ 288×144`。超える span は **拒否**（クランプしない＝予測可能性優先）。
4. text fit: 内寸 = `w − 2(border+padding)`、行数 = `floor(innerH / 27)`。**幅は文字数でなく px（`getTextWidth` / pretext）で判定**（全角・CJK・絵文字対応）。切り詰め・折返しは px で行い、切る単位は **grapheme**（`Intl.Segmenter` か code point 単位）にしてサロゲートペア / 結合文字を割らない。CJK は空白が無いので任意位置で折り返せる前提。
5. event 層注入: 全面透明 text container を **最後に 1 個** compiler が注入（layout には書かせない）。image は event 不可なのでこれが入力受け。→ user が置ける text cell は実質 **7 個**（8 − event 層）。

### 制約・ルール
- image は最大 288×144（画面の 1/4）。全画面・フル幅横長の画像は不可。
- z-index 無し → セルは重ねない（重なりは compiler が拒否）。
- **枠線と行高の関係（注意）**: 1 行高（rowSpan=1 = 28.8px）のセルに border+padding を入れると `innerH < 27` で行が消える。**枠を付けるなら rowSpan≥2**。1 行セルは border 0 / padding 0 を既定にする。compiler は「枠付きで 1 行も入らないセル」を警告/拒否。
- レイアウト変更 = `rebuildPageContainer`（ちらつき）/ 中身更新 = `textContainerUpgrade`・`updateImageRawData`（ちらつき無し）→ 配置（grid）は固定運用し、データをセルに流し込む 2 層構成。
- **全角 / grapheme（重要）**: 幅は px（`getTextWidth`）で測る。現状の `formatSegmentValue` / `pad` は `.length`（UTF-16 code unit）ベースで、全角・絵文字で列ズレ / 誤切り詰め / サロゲート分断が起きる既存バグ（`widthChars` 使用時に顕在）。grid の text-fit ではこれを使わず **px + grapheme** に統一する。行全体の overflow 防止（`justifyClusters`）は既に px なので全角でも 2 ページ目には溢れない。
- 実機確認（0.1.54 / build #24909, 2026-05-30）: firmware font は **CJK（漢字 / かな / 全角数字 / 円）＋ 絵文字（☀ ☁ ☂ 😀 🎉 🔥）とも描画される**。10 行も維持。
- 実機で **線形(page2)は列が揃わないことを確認**（`|...|` の右端が縦に揃わない）。proportional フォントでは space パディングで px 揃えは原理的に不可。→ **厳密な列揃えは grid の座標配置コンテナ専用**とする。EAW 修正は「列揃え」のためではなく **絵文字分断・過大幅・誤切り詰めの是正**として維持し、線形 status line の widthChars は近似のまま割り切る。
- **grid PoC 実機検証 OK（0.1.55 / build #24920, 2026-05-30）**: page3 の grid が描画され、**multi-container（createStartUp/rebuild）が動作**、枠付き値セル（col3=x144）の**左端が px で揃う**ことを確認。→「厳密な列揃えは grid で担保」を実機で裏取り。grid MVP の方向が成立。

### データ束縛
- text cell: 既存 segment 参照（groupId/segmentId）を N 行表示。現状 `renderGlass` のロジックをセル内寸に一般化。
- image cell: **client 描画を標準**（`icon` / `sparkline` / `bitmap` を declarative 宣言 → クライアントで 4-bit 変換）。server が画像バイトを返す方式は BLE 遅延 / サイズ / 互換リスクが高いので後回し。
- **絵文字グリフで代替（実機確認・重要）**: firmware font が絵文字を描画できるので、天気 ☀☁☂🌧 / 状態アイコンのような単純な絵は **text cell の絵文字で出せる**。image container（1 枚 0.5〜2s/BLE・≤4・逐次）を使わずに済む。image cell は**本物のグラフ / ビットマップ**専用に温存し、アイコン類はまず絵文字 text を試す。

### 後方互換
現状の線形 status line = 「12×10 グリッドに全面 1 text cell（colSpan=12, rowSpan=10）を置き summary view を束縛」した 1 プリセット。描画結果を変えずに移行できる。

### MVP スコープ
1. layout スキーマ + compiler（text セルのみ・固定 12×10・overlap/上限/text-fit・event 層注入）。
2. 現状 status line を「全面 text cell」プリセットとして compiler 経由に載せ替え（描画不変を確認）。
3. image cell（client 描画: weather icon / sparkline）を追加。
4. companion グリッドエディタ（ドラッグ + span、上限・重なりを弾く）。

---

## SDK 調査: サイドメニュー / ポップアップ表現（Even Hub SDK 0.0.10）

### 結論
ネイティブの drawer / popup / sheet / modal / overlay は companion・glass のどちらにも無い。
近い表現は次の 2 つで作る。

- companion: WebView なので自前 Web UI で自由に作れる（SDK は不要・かつ非提供）。
- glass: `ListContainerProperty`（選択リスト）が唯一のネイティブ「メニュー」相当。サブ階層は `rebuildPageContainer` のページ差し替えで模倣。

### companion（スマホ WebView）
- SDK はナビ / ページスタック / ドロワー / シートを提供しない。bridge API のみ。`shutDownPageContainer(1)` だけが OS 管轄のネイティブ終了確認ダイアログ。
- ドロワー / ボトムシート / モーダルは HTML/CSS/JS で自前実装（`position:fixed` + `transform: translate`、標準 `<dialog>` 等）。Android=Chromium / iOS=WKWebView でブラウザ標準 API はほぼ使える。
- 制約: `env(safe-area-inset-*)` は非対応の可能性（固定パディング推奨）。ネイティブの戻る / edge-swipe をホストが横取りする場合あり。`LaunchSource`（`appMenu` | `glassesMenu`）で起動経路を判定し UI 分岐は可能。
- 実用パターン: R1 リングの `CLICK` / `DOUBLE_CLICK` を `bridge.onEvenHubEvent` で受け、コールバック内で `.drawer` を `classList.toggle('open')` → 「グラスのリング入力でスマホ UI のドロワー/メニューを開閉」。

### glass（G2）
- UI コンテナは Text / List / Image の 3 種。1 ページ最大 12（**text/list 合計 8 + image 4**）。`containerID`(数値) と `containerName`(≤16 字) はページ内ユニーク。
- 各コンテナは `xPosition/yPosition/width/height` で**座標配置**できる。text/list は `borderWidth(0-5)/borderColor(0-15)/borderRadius(0-10)/paddingLength(0-32)` で**枠**を描ける（= 擬似カード/ポップアップ枠が作れる）。image は 20-288×20-144。
- z-index は無く**宣言順で重なる**（後の宣言が上）。`isEventCapture:1` のコンテナが入力を受ける（ページに必ず 1 つ）。image は event capture 不可なので、画像主体ページは全面の透明 text を event 層に置く。
- メニュー相当は `ListContainerProperty` が唯一: `itemCount`≤20、`itemName`≤64 文字、`isItemSelectBorderEn:1` でハイライト、`isEventCapture:1`（1 ページ 1 個）で click/scroll を受信。ハイライト移動は FW が自動管理。
- 入力: R1 リング / 両テンプルタッチパッド（press / double press / swipe up・down）。`listEvent.eventType`: `CLICK=0` / `SCROLL_TOP=1` / `SCROLL_BOTTOM=2` / `DOUBLE_CLICK=3`。`EventSourceType` で R/L テンプル・リングを判別。
- ポップアップ/モーダルは無い → `rebuildPageContainer` でページ全差し替え（フリッカーあり）で画面遷移を模倣。`TextContainer` に罫線文字（`┌─┐│└─┘`）で疑似枠は可。
- 0.0.10 で使える API: `createStartUpPageContainer` / `rebuildPageContainer` / `textContainerUpgrade`（フリッカーなしのテキスト更新）/ `updateImageRawData` / `onEvenHubEvent`（listEvent / textEvent / sysEvent）。
- 更新の使い分け: 頻繁更新（カウンタ/status line）は `textContainerUpgrade`（ちらつき無し・≤2000 字・id/name 完全一致必須）。レイアウト変更/リスト更新は `rebuildPageContainer`（全描画・ちらつき・≤1000 字/text）。`createStartUpPageContainer` は**一度だけ**。
- BLE コスト: 画像は 1 枚 ~0.5–2s（圧縮/差分なし）・`updateImageRawData` は**逐次**（並行不可）。bridge 呼び出しは全て await で直列化。`setLocalStorage` は同じ BLE を共有するので debounce。各呼び出しに数秒の timeout を被せる（1 ホップで ~30s ハングしうる）。テキスト更新は画像より遥かに速い。
- 未対応: glass のポップアップ/モーダル/オーバーレイ、複数ページスタック/戻るナビ、companion ネイティブ drawer/sheet、glass テキストのフォントサイズ/太字/色制御、`setBackgroundState`/`onBackgroundRestore`。

### この toolbar への含意
- companion の設定 UI を drawer / popup 化するのは Web 実装で自由（SDK 不要）。リング入力連動も可能。
- グラスを「メニューで操作するアプリ」にするなら 2 方式: (1) `ListContainer`（FW がハイライト/スクロール管理・native・推奨）、(2) bordered text + `>` カーソルの自前メニュー（レイアウト自由だが選択移動ごとに `rebuildPageContainer`=ちらつき）。サブ階層はどちらも `rebuildPageContainer` で次ページへ、戻りは `DOUBLE_CLICK`/`SCROLL` に割り当て、スタックは JS 管理。現状は status line 描画なので、メニュー化は描画モデルの追加が要る。
- Widget グリッド構想との関係: コンテナは座標配置 + 枠描画ができるので**グリッドは実装可能**。ただし 1 ページ最大 12（text/list 8 + image 4）がセル数の上限。詳細は「UI 拡張アイデア」の実現性を参照。

### アニメーション 実機検証（2026-05-30, 0.1.62〜64）
- **滑らかな fade / scroll アニメは SDK 経由では不可**（確定）。理由: `TextContainerProperty` に**テキストの輝度/色フィールドが無い**（`borderColor` のみ）→ 文字をフェードできない。`animation`/`transition`/`opacity`/`duration` API も無い。コマ送りは `rebuildPageContainer`（ちらつき）か画像（1 枚 0.5〜2s/BLE）で BLE 律速→カクつく。標準ダッシュボードの fade/scroll は firmware ネイティブ UI で別物。
- 唯一のネイティブな動き = `ListContainer` のスクロール。**実機で試した（page6 list 実験, 0.1.63/64）が、ListContainer 単体ページが正しく描画されず断念（ボツ）**。`ListContainerProperty` には `isEventCapture` フィールドが無く、event 用 text 層との両立も不明。→ **通知 UI は custom card（popup, page4）のまま**。滑らかスクロール/フェードは諦め、必要なら dissolve（文字を空白化, `textContainerUpgrade` でちらつき無し）程度。

出典: Even Hub Docs（getting-started/first-app・architecture、guides/display・input-events）。
