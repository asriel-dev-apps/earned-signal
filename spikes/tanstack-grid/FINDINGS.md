# Spike: TanStack ヘッドレス仮想化グリッド — WBS グリッド耐久検証

対象: ADR 0011 実装順①。`apps/web` を TanStack で作り直す前に、ヘッドレス仮想化グリッド
（TanStack Table v8 + TanStack Virtual v3）が過酷な WBS グリッド要件を捌けるかを確認し、
step②（本番の仮想化フラットグリッド）へ進む GO/NO-GO を出す。AG Grid は不採用確定。

これは使い捨てスパイクであり本番品質ではない。データは全てコード内生成の合成データ
（`src/data.ts`、seeded PRNG）。実クライアントデータ・実スプレッドシート由来のフィクスチャは一切不使用。

---

## 判定: **GO（軽微な caveat 付き）**

3000 行 × 113 列（23 メタ + 90 日別）＝論理 339,000 セルの過酷な組み合わせを、
TanStack Table v8（ツリー展開）＋ TanStack Virtual v3（行・日別列の二軸仮想化）＋
左列固定＋ヘッダ固定＋ dnd-kit 付替を**全部同時に**成立させられた。
production ビルドでは、全高・全幅を走破する負荷スクロール中に **50ms 超のロングタスクがゼロ**。
DOM ノード数はデータ規模ではなくビューポートに比例して有界。

caveat は「性能の懸念」ではなく「計測環境の制約」と「step② の設計時に踏むべき地雷」に関するもの
（後述）。証跡は `artifacts/` に保存。

---

## 何を作ったか

- standalone Vite + React 19 + TypeScript アプリ。`spikes/tanstack-grid/`（pnpm workspace glob の外、独自 `package.json`）。
- スタック: `@tanstack/react-table@8.21`, `@tanstack/react-virtual@3.14`, `@dnd-kit/core@6.3`, React 19.2, Vite 7.3。
- 論理グリッド:
  - **3000 行**（2 階層ツリー: 親タスク＋サブタスク、合成生成。全展開時にフラット化して丁度 3000 行）。
  - **113 列** = メタ 23 列（No / 工程 / タスク / 担当 / 工数(人時) / 進捗率 / Col07..Col23）＋日別 90 列（`D+0..D+89`）。
- 左端 4 メタ列（No / 工程 / タスク / 担当）を**固定（sticky-left）**、ヘッダを**固定（sticky-top）**。
- ツリーは TanStack Table `getExpandedRowModel` + `subRows`。展開行をフラット化して行仮想化へ。
- ドラッグ付替は `@dnd-kit/core`（実ポインタドラッグでツリー上を移動）。

---

## 実測 perf 数値（Playwright / headless Chromium で実駆動して採取）

計測手順: 稼働中サーバに Playwright で接続 → `window.__perf.runScroll()`（ページ内 rAF ループ）で
**全高 89,234px / 全幅 4,770px を 120 フレームで走破**する負荷スクロールを実行し、
`PerformanceObserver('longtask')` と rAF デルタを採取。詳細生データは `artifacts/perf_dev.json` / `artifacts/perf_prod.json`。

| 指標 | dev サーバ | **production build (`vite preview`)** |
|---|---|---|
| 論理グリッド | 3000 行 × 113 列（=339,000 論理セル） | 同左 |
| 描画 DOM（初期・スクロール前） | 38 行ノード / **1,064 セルノード** / 1,306 総 DOM | 38 行 / **1,064 セル** / 1,306 総 DOM |
| 縦スクロール最下部到達後の DOM | 39 行 / 1,092 セル | 39 行 / 1,092 セル |
| 横スクロール最右到達後の DOM（日別列が全て可視化） | 39 行 / **2,145 セル**（うち日別 1,248） | 39 行 / **2,145 セル** |
| ヘッダ固定の実測（縦スクロール後の header top − scroller top） | **1px**（=固定成立） | 1px |
| 左列固定の実測（横スクロール後の pinned left − scroller left） | **1px**（=固定成立） | 1px |
| 縦スクロール中ロングタスク（>50ms） | 1 件 / 最悪 70ms / 計 70ms | **0 件** |
| 横スクロール中ロングタスク（>50ms） | 9 件 / 最悪 62ms / 計 495ms | **0 件** |
| 展開/折畳 | 3000 → 2998（親1つ折畳） | 3000 → 2998 |
| ドラッグ付替 | サブタスク2 を 親タスク1→親タスク4 へ移動（depth 維持、総数 3000 維持） | 同左 |
| console エラー | なし | なし |

### 計測の信頼性に関する重要な注意（正直な但し書き）

- **rAF 由来のフレーム時間（worstFrame / p95）はこの環境では fps の指標として使えない。**
  headless Chromium にはディスプレイ同期が無く、rAF が低頻度に固定される。実測の「アイドル rAF ベースライン」
  （スクロールを一切せず 60 フレーム採取）が worst 133.3ms / median 66.6ms / avg 65.5ms で、
  スクロール中のフレーム時間（p95 133.3ms）と**ほぼ同一**。つまり 133ms 前後の数字は
  レンダリングコストではなく headless の rAF スケジューリング床。よってフレーム時間は本レポートでは根拠に採らない。
- 信頼できるジャンク指標は **PerformanceObserver('longtask')**（rAF 頻度に依らず 50ms 超のメインスレッドブロックを捕捉）。
  これが **production で全プローブ 0 件**（縦・横 × dnd ON/OFF、いずれも全域走破）というのが GO の中核の証跡。
- dev の数値（縦 1 件、横 9〜10 件・計 ~500ms）は React 開発モード＋Vite 非圧縮のオーバーヘッドで、production で消える。
- 推奨: step② 確定前に、実表示のあるブラウザ（headed）で人手により一度スムーズさを目視確認するのが安価で確実。
  ただしロングタスク証跡は既に GO を支持する。

---

## 採用した二軸仮想化アプローチ

- **単一スクロールコンテナ**（`.scroller`, `overflow:auto`）に対して `useVirtualizer` を 2 つ生成:
  - 行（縦）: `count = table.getRowModel().rows.length`、固定 `estimateSize = 30`、`overscan 12`。
  - 日別列（横）: `horizontal:true`, `count = 90`, `estimateSize = 46`, `overscan 4`。
- **メタ 23 列は仮想化しない**（常時レンダリング）。横仮想化するのは**日別 90 列のみ**。
  これで横スクロール時も左のメタ列は常に存在し、固定表示が単純化される。
- **`paddingStart` が最大の勘所**（後述 gotcha #1）。行仮想化に `paddingStart = HEADER_H(40)`、
  日別列仮想化に `paddingStart = META_WIDTH(1770)` を渡し、仮想化器の座標系を実描画位置
  （ヘッダ帯・メタ列帯のオフセット）と一致させている。これが無いと日別列の可視判定がズレて
  画面外のセルをマウントしたり、可視セルを描かなかったりする。
- 効果: 論理 339,000 セルに対し、描画セルは静止時 1,064、日別列まで全可視化しても 2,145 で頭打ち。
  **データ規模ではなくビューポートに比例**。二軸仮想化が実際に効いている実証。

## 左列固定の実装戦略

- **ネスト sticky**:
  - ヘッダ行全体 = `position:sticky; top:0`（縦スクロールで固定）。
  - 各行の左端グループ（pinned-group）= `position:sticky; left:0`（横スクロールで固定）。ヘッダ内にも同じ pinned-group。
- 各行は絶対配置（`top: virtualRow.start`）、その中で pinned-group だけが normal-flow の sticky、
  日別・非固定メタセルは `position:absolute` で左オフセット配置。
- 必須だった注意点: (a) z-index の帯分け（ヘッダ帯 > ボディ、pinned > スクロールセル）、
  (b) pinned-group とヘッダに**不透明背景**（下をスクロールするセルの透け防止）。
- 実測で header/pinned の固定オフセットが共に 1px（＝ボーダー分のみ、実質 0）で、固定が成立していることを数値で確認。

## ツリー階層（展開/折畳）

- `getRowId: row => row.id` ＋ `expanded` を record 管理。初期は全親 `true`（全展開＝フラット 3000 行の最悪ケース）。
- `table.getRowModel().rows` が展開状態を反映してフラット化した配列を返すので、それを行仮想化に流すだけ。
- 折畳で 3000→2998、再展開で復元を実測（`artifacts/*-04/05-*.png`）。

## ドラッグ実装の選択（dnd-kit）と A/B

- `@dnd-kit/core` の `DndContext` + 各行 `useDraggable`（左端グループがハンドル）/ `useDroppable`（行全体がドロップ先）。
  `PointerSensor` activation distance 6px（トグルのクリックやスクロールと誤発火しない）。
- 付替は state 上のツリーを組み替え（子を旧親から除去→新親の `subRows` 末尾へ）。TanStack が再フラット化・再描画。
- Playwright の実ポインタドラッグで成立（`artifacts/*-06/07-*.png`：サブタスク2 が親タスク1→親タスク4 配下へ移動）。
- **A/B（dnd-kit の行あたり登録コスト）**: 画面のトグルで `useDraggable/useDroppable` の有無を切替えて同じ負荷スクロールを再計測。
  - dev 横スクロール: ON = 9 件/495ms、OFF = 10 件/517ms → **有意差なし**。
  - production: ON/OFF とも 0 件。
  - 結論: 3000 行規模で**行あたり draggable/droppable 登録はスクロール性能を悪化させない**。

---

## step② の計画を左右する具体的 gotcha / 推奨事項

1. **`paddingStart` を二軸とも必ず設定する（最重要）。**
   ヘッダ帯・固定メタ列帯のオフセットを仮想化器の座標系に織り込まないと、日別列の可視判定と実描画位置がズレる。
   step② でも「常時描画領域（メタ列）＋仮想化領域（日別列）」のハイブリッドを採るなら同じ調整が要る。

2. **DndContext を安定にマウントし続ける。**
   本スパイクで、dnd 機能のトグルでスクローラ DOM が remount され、スクロール位置と perf ハンドルが失われる不具合を踏んだ
   （最初の計測で横 A/B が `reached=0/0` になった）。DndContext を常時マウントし、スクローラは callback ref で参照することで解消。
   step② では DndContext をツリー上位に固定配置し、機能トグルで再マウントさせないこと。

3. **横方向のピーク DOM は overscan 依存で ~2,145 セル**（例示された「< ~2000」を僅かに超える）。
   38 行 × 約 56 列（メタ 23 常時＋日別 ~33）による。ハード上限が要るなら overscan（行 12・列 4）を絞れば容易に 2000 未満へ。
   静止時は 1,064 で余裕。ブロッカーではないがチューニング項目として明記。

4. **メタ列は非仮想化のハイブリッド。** 23 列なら常時描画で問題ないが、メタ列が大幅増（列固定候補が増える）と
   横方向の DOM 下限が上がる。step② でメタ列数が動的に増えるなら再計測。

5. **flexRender を意図的に迂回している。**
   本スパイクはセル描画を手書き（`row.original` から直接値取得）にして、TanStack Table は
   「展開行モデル＋行 API（depth / getCanExpand / getToggleExpandedHandler / subRows フラット化）」に用いた。
   step② でソート/フィルタ/列リサイズ等の列機能を `flexRender` で回すなら**セルあたり React コストが増える**ので再計測が必要。
   ヘッドレスの旨味（描画は自前・状態は TanStack）はそのまま活かせる。

6. **dnd-kit × 仮想化の「遠距離ドラッグ」。**
   可視範囲内の付替は問題ないが、行5→行2500 のように**ドラッグ元/先がスクロールで unmount される遠距離付替**は
   dnd-kit の測定戦略・auto-scroll 設計が要る（本スパイクでは検証範囲外）。step② で長距離の親付替 UX が要件なら、
   auto-scroll 追従＋ドラッグ中の登録維持を設計に入れること。

7. **計測は production ビルドで採ること。** dev（React 非圧縮）と production でロングタスク数が桁違い（495ms → 0）。
   step② の受入計測は必ず `vite build` 済みで。

8. **環境メモ（結論には無関係）。** 実行環境の Node は 23.6.0（24.x 不在）。corepack の署名鍵バグ＋
   pnpm 11.12.0 が broken release のため、pnpm 10.34.5 を使用し、本スパイクの `.npmrc` に
   `manage-package-manager-versions=false`、`pnpm-workspace.yaml` を独自配置してルート workspace から隔離した。
   ブラウザ側の結論には影響しない。

---

## 受入証跡（`artifacts/`）

- `perf_dev.json` / `perf_prod.json` — 全計測の生データ（DOM 数・ロングタスク・固定オフセット・ドラッグ判定）。
- `dev-01..07-*.png` / `prod-01..07-*.png` — 初期 / 縦最下部（ヘッダ固定）/ 横最右（左列固定＋日別列）/ 展開前 / 折畳後 / ドラッグ前 / ドラッグ後。

## 再現方法

    cd spikes/tanstack-grid
    pnpm install          # 隔離 workspace。ルートには一切触れない
    pnpm typecheck        # クリーン
    pnpm build            # クリーン
    pnpm dev              # http://localhost:5188/

受入計測の再駆動（サーバ稼働中に）:

    # production の realistic perf を採るなら preview を別ポートで:
    pnpm exec vite preview --port 4188 --strictPort
    # Playwright ドライバ（uv 経由、ブラウザは自動取得）:
    uv run --with playwright==1.56.0 python acceptance.py http://localhost:4188/ prod
