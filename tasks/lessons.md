# Lessons (eveng2-toolbar)

同じミスを繰り返さないための自分向けルール。セッション開始時にレビューする。

## CI 構成は memory/agent 報告でなく実ファイル(ci.yml)で確認する

2026-05-31, 静的解析導入 (PR #48)。

- 何が起きたか: Biome の lint を `biome check src/` → `biome check .` に全体化。ローカルの build/test は緑だったが CI が red。原因は `ci.yml` の build job が `bun run lint` も実行していたこと。lint 全体化で `server/cli/install.ts` の意図的パーサ (noParameterAssign 5件) が CI を落とした。
- なぜ起きたか: memory(eveng2-ci-and-repo-rename) と workflow の検証 agent が「CI=build のみ」と記述しており、それを鵜呑みにして「CI に lint は無い」とユーザーに説明した。結果、ユーザーは誤った前提で install.ts を範囲外に選んだ。
- ルール:
  1. lint/format/型チェックの適用範囲を変える変更 (対象 glob 拡大、rule 追加等) をするときは、push 前に `.github/workflows/*.yml` を実読し、その check が CI のどの job で走るか確認する。
  2. CI 構成を memory や subagent の要約で判断しない。`ci.yml` が一次情報。memory が古い可能性を常に疑う。
  3. 「ローカルで build/test 緑」≠「CI 緑」。CI が走らせるコマンド一式 (install/lint/build/test) をローカルで同条件に再現してから push する。

## biome の overrides に `comment` キーは使えない

2026-05-31, 同 PR。`biome.json` の overrides に `comment` を入れると `Found an unknown key \`comment\`` で設定全体が fail する。意図の説明はコミット/PR 側に書く。biome.json でのコメントは未検証なので避ける。

## biome のフォルダ無視は `!docs` 形式

`files.includes` でフォルダ全体を除外するなら `!docs`。`!docs/` は効かず、`!docs/**` は `useBiomeIgnoreFolder` warning を出す。

## 共有リポジトリで並行プロセス(別セッション/ユーザー)が動く前提を持つ

2026-05-31, 循環解消 (PR #52)。

- 何が起きたか: 循環解消の作業中、別プロセスが同じ working tree / ブランチで commit・編集していた。git status の M ファイル(weather.ts +352 等)が一瞬で消え、HEAD が動き(release 0.1.5)、origin/main が 9578f6b→d141089→8b10efb と進んだ。自分の変更と第三者変更が working tree で混線した。
- なぜ起きたか: 同一 checkout を複数アクターが共有している前提を持たず、自分専用 working tree のつもりで git status を読んだ。git diff --stat と git diff <file> の食い違いで初めて気づいた。
- ルール:
  1. コミット直前に必ず git status を取り直す。`git diff --stat` と `git diff <file>` が食い違ったら別プロセスが動いている兆候。
  2. 自分の変更だけを選択的に stash (pathspec + -u) し、`origin/main` 由来の clean な新ブランチに移してからコミットする。`git add -A` で working tree 全体を巻き込まない。
  3. 第三者の未コミット変更(implementation-notes.html 等)は触らない・stash しない・add しない。
  4. 大きめの作業は最初から worktree 隔離 ([[eveng2-autonomous-merge-policy]]) を検討する。

## プロジェクト CLAUDE.md に個人環境依存を書かない

2026-05-31, Even Hub upload の CI 化セッション。

- 何が起きたか: 「GPT-5.5 の議論は codex 優先」をプロジェクト CLAUDE.md に追記する際、`codex exec --sandbox read-only ...` の具体コマンド・`~/.codex/config.toml`・個人グローバル CLAUDE.md の方針参照をそのまま書いた。ユーザーに「私の環境にしか無いもので別メンバーのマシンで支障をきたす」と指摘された。
- なぜ起きたか: プロジェクト CLAUDE.md は repo にコミットされ全コントリビューターに配られる前提を忘れ、自分(ユーザー個人環境)の運用手順をそのまま転記した。
- ルール:
  1. プロジェクト CLAUDE.md(repo 管理) に書くのは、誰の環境でも成り立つ意図・方針のみ。個人のホームパス (`~/.config`, `~/.codex`)・個人 CLI の具体コマンド・個人グローバル CLAUDE.md への参照は書かない。
  2. ツール固有の指示が要るなら「複数手段を持つ場合の優先順位。いずれも無い環境では適用しない」と条件付き no-op の言い回しにする。
  3. 個人運用手順はグローバル (`~/.claude/CLAUDE.md`) 側に置く。プロジェクト側はチーム共有される前提で書く。

## ユーザーの抽象的な題目より「具体ワークフロー」を先に確定する

2026-06-02, source identity セッション。

- 何が起きたか: 「同じ Mac のようなマシンを異なるネットワークで…machine 名は同一…自宅用とオフィス用」を「物理的に別の 2 台を区別したい」と解釈し、installId による別マシン区別という大掛かりな再設計(workflow 5並列 + gpt5.5 議論 + plan)まで進めた。AskUserQuestion でも「別マシンを区別」を選ばせてしまった。だがユーザーの実問題は逆で「1 台のノートを移動させると IP が変わる、毎回編集したくない(ローミング)」だった。plan を ExitPlanMode で出した直後に取り違いが発覚し破棄。
- なぜ起きたか: (1)「自宅用/オフィス用」「machine 名が同一」という抽象語から具体の作業像(1 台が動くのか 2 台あるのか)を確認せず設計に入った。(2) 既存機能(urls[] failover = 1 source 複数 IP)が実問題をほぼ解くことを最初に提示しなかった。AskUserQuestion の選択肢自体が誤った前提(別マシン)で組まれていた。
- ルール:
  1. シナリオ系の要望は、設計前に具体ワークフローを一文で復唱して確認する。「1 台を持ち歩いて IP が変わる」のか「2 台が同名で衝突」なのかは正反対。抽象語の枠選択(AskUserQuestion)を具体確認の代わりにしない。
  2. 大掛かりな新機構を設計する前に「既存機能で解けないか」を必ず一度提示する。ここでは urls[] failover が既出で、根本解は安定名(.local/Tailscale)というほぼ無改修の答えだった。
  3. workflow/LLM 議論/plan に投資する前ほど、前提(誰の何の作業か)を安く確認する。コストの高い工程ほど前提ミスの損失が大きい。

## レビュー/設計 workflow の運用 (2026-06-03)
- Workflow の検証/統合エージェント(Explore 以外=書込可)は、検証のためにリポジトリルートへ scratch ファイル(例 `test-bug.ts`)を作ることがある。これが lint gate(import order 等)を壊す。**review workflow 後は必ず `git status` で野良ファイルを確認・削除する**。
- codex(gpt5.5) を `codex exec` で呼ぶときは **`< /dev/null` 必須**。付け忘れると stdin 待ちで擬似ハングし出力ゼロのまま固まる。
- 通知/アラートの発火は「inline 表示の可視判定(fail-open)」とは別軸。fail-open(na→true) を発火に流用すると誤発火する。発火は strict tri-state(known false→known true)で、未観測(undefined)は arm のみ=storm 防止(サーモスタット式)。

## 既存データ構造に新フィールドを足すとき、既存フィールドの「全 touch 箇所」を呼び出し元まで辿って分類する (2026-06-04)

2026-06-04, グラス意図的マルチページ (pages 追加)。

- 何が起きたか: `ProfileView.pages` を追加し、既存 `glassLayout` を触る箇所を pages 対応にした。Plan で「migration-only ヘルパ(consolidate/location-merge/reKey/merge/restore)は backfill 順序で吸収、runtime 経路の removePlace/discardSource のみ pages 対応」と分類した。だが `reKeySource`/`mergeSourceViewInto` は `reconcileSourceMachine`(companion の接続テスト=runtime)から呼ばれるのに「migration-only」と誤分類し pages 対応を漏らした。結果、source merge / id 安定化で pages の chip が remap されず配置が壊れた。e2e(source-stability の merge テスト)が捕捉。`consolidateClock` も active profile のみ remap していて非 active profile の pages に旧 key が残るバグを codex レビューが指摘。
- なぜ起きたか: (1) ヘルパを「ファイル内の位置・名前」で migration/runtime に分類し、実際の呼び出し元(reconcileSourceMachine が runtime)を辿らなかった。(2) `activeView()` を使うヘルパ(consolidateClock)が「active だけ直せばいい」という暗黙前提を、pages 化で全 profile が描画対象になる文脈で見落とした。
- ルール:
  1. 既存フィールド X に並ぶ新フィールド Y を足すなら、`rg 'X'` で全 touch 箇所を出し、各箇所ごとに「誰が呼ぶか(migration の load 経路 / companion runtime / 両方)」を呼び出し元まで辿って表にする。名前や位置で migration-only と決めつけない。
  2. `activeView()`/`activeProfile()` だけを触るヘルパは、その出力が全 profile で描画されうるか確認する。pages のように「profile 切替で非 active も前面に出る」構造では全 profile ループへ拡張する。
  3. backfill/正規化より前に走るヘルパは、未正規化(壊れた layout=null 等)のデータに触れる。null ガードを入れる。
  4. companion UI/IA に関わる変更は `bun run test:e2e` をローカルで回す ([[eveng2-e2e-not-in-default-gate]])。今回 merge の配置破壊は unit では出ず e2e で出た。
