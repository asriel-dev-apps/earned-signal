# PostgreSQL永続化の技術調査

調査日：2026-07-14

対象：EarnedSignal Issue #4

## 結論

EarnedSignalの永続化には、PostgreSQL、Drizzle ORM、`node-postgres`、Cloudflare Hyperdriveを組み合わせる。
Workerはリクエストごとに`pg.Client`を生成し、その接続を`drizzle-orm/node-postgres`へ渡す。
マイグレーションはWorker起動時に実行せず、Drizzle Kitで生成したSQLをCIまたはリリース工程からデータベースへ直接適用する。

初期リリースでは、Hyperdriveのクエリキャッシュを無効にした構成を使う。
認証、権限、WBS更新、監査ログ、ベースライン確定はread-after-write整合性を必要とする一方、Hyperdriveは書き込み時にキャッシュ済みSELECTを無効化しないためである。
読み取り負荷が観測されてから、鮮度の遅延を許容できるダッシュボード専用にキャッシュ有効の構成を追加する。

## WorkerからPostgreSQLへの接続

CloudflareはJavaScriptおよびTypeScriptのWorkerに`node-postgres`を推奨している。
専用の接続例は`pg@>8.16.3`、`nodejs_compat`、2024-09-23以降のcompatibility dateを要件としている。
CloudflareのDrizzle例も、Hyperdriveの`connectionString`で`pg.Client`へ接続し、そのClientからDrizzleインスタンスを作る構成を示している。
([Cloudflare: node-postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)、[Cloudflare: Drizzle ORM](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/))

CloudflareのPostgreSQL概要にあるdriver一覧は古い最低versionも併記しているが、同じページの詳細節と専用ページは`pg@>8.16.3`を要求している。
実装では、より新しく具体的な専用ページの要件を採用する。

Clientはモジュールのグローバル領域に置かず、`fetch`などの各ハンドラー内で生成する。
WorkersはリクエストをまたぐI/Oを許可せず、前のリクエストのClientを再利用するとstale connectionになる。
Hyperdriveがオリジン側の接続プールを維持するため、Worker側に`pg.Pool`を作る必要もない。
通常のWorkerリクエストでは`client.end()`も不要であり、呼び出し終了時にWorker側の接続が回収される。
([Cloudflare: Connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/))

概念上の接続境界は次の形になる。

```ts
const client = new Client({
  connectionString: env.HYPERDRIVE.connectionString,
});

await client.connect();
const db = drizzle(client, { schema });
```

このコードは接続方法を示すものであり、例外処理やアプリケーション境界を定める完成コードではない。
RepositoryまたはUnit of Workは`db`を引数として受け取り、HTTP、REST、MCPの各入口が同じ永続化処理を呼ぶ構成にする。

## Hyperdriveの整合性と接続制約

Hyperdriveのプールは**トランザクションモード**で動作する。
同一トランザクション中は一つのオリジン接続を保持し、完了後に接続をプールへ返す。
`SET`の状態はトランザクションまたは単一クエリの範囲に限定され、接続返却時にリセットされる。
([Cloudflare: How Hyperdrive works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/))

したがって、セッション状態へ依存する設計は採用しない。
SQLレベルの`PREPARE`、`EXECUTE`、`DEALLOCATE`、advisory lock、`LISTEN`、`NOTIFY`もHyperdriveでは非対応である。
一方、`node-postgres`のquery configに`name`を指定するプロトコルレベルのnamed prepared statementは対応している。
([Cloudflare: Supported databases and features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)、[node-postgres: Queries](https://node-postgres.com/features/queries))

named prepared statementは初期実装の必須要件にしない。
`node-postgres`自身も、複雑かつ高頻度なクエリ以外では早期の最適化になりやすいと説明している。
まずパラメーター化クエリを使い、SQLインジェクションを避ける。
実測でparseとplanの負荷が問題になったクエリだけに、安定した一意の名前を付ける。
([node-postgres: Queries](https://node-postgres.com/features/queries))

Hyperdriveは既定で読み取りクエリをキャッシュするが、書き込みで既存キャッシュを無効化しない。
認証、session、permission、課金状態、書き込み直後の読み取りには、Cloudflareもcache-disabled構成を推奨している。
EarnedSignalではWBS更新と監査結果の即時反映も同じ性質を持つ。
([Cloudflare: Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/))

クエリの最大実行時間は60秒である。
オリジン接続の目安はFreeプランで約20、Paidプランで約100接続だが、可用性維持のため一時的に超える場合がある。
長いクエリやトランザクションは接続を占有してプール枯渇を起こすため、シミュレーションのCPU処理や外部API呼び出しをトランザクション内へ入れない。
([Cloudflare: Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/))

## Drizzle schemaとマイグレーション

TypeScriptのDrizzle schemaをデータ構造のソースとして管理し、`drizzle-kit generate`でSQLとschema snapshotを生成する。
生成物をレビューしてリポジトリへ保存し、`drizzle-kit migrate`で未適用分だけを適用する。
Drizzle Kitは適用済みマイグレーションを既定の`drizzle.__drizzle_migrations`へ記録する。
([Drizzle: generate](https://orm.drizzle.team/docs/drizzle-kit-generate)、[Drizzle: migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate))

`drizzle-kit push`は開発者の試行用には使えるが、共有環境と本番の標準経路にはしない。
SQLファイルを残す`generate`と`migrate`の組み合わせなら、変更内容のレビュー、再現、環境間の適用順序を検証できる。
これはDrizzleが列挙するcodebase-first方式のうち、生成SQLを適用する方式に当たる。
([Drizzle: Migrations](https://orm.drizzle.team/docs/migrations))

マイグレーションはHyperdrive経由でWorkerが自動実行せず、`DATABASE_URL`でPostgreSQLへ直接接続するリリース工程から実行する。
CloudflareのDrizzle例も、Drizzle Kit用の直接接続URLをWorkerのHyperdrive bindingとは別に設定している。
これにより、通常リクエストの60秒制限やトランザクションプールへDDLの責務を持ち込まない。
([Cloudflare: Drizzle ORM](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/))

## 値型の方針

### 金額と比率

PostgreSQLの`numeric`は任意精度の10進数であり、金額など正確さが必要な値に推奨されている。
一方、`real`と`double precision`は2進浮動小数点による近似値である。
精度とscaleを指定した`numeric(p, s)`は入力をscaleへ丸め、整数部が許容桁数を超えるとエラーにする。
([PostgreSQL: Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html))

EarnedSignalでは、通貨額を**最小通貨単位の`bigint`**で保存する。
JPYなら1が1円、USDなら1が1セントとなり、EVMのBAC、PV、EV、ACを整数として加減算できる。
この方式は現行ドメインの「通貨値を丸めずに計算する」という意図を保ちつつ、JavaScriptの浮動小数点誤差を永続化層へ持ち込まない。

ただし、時間単価、為替レート、配賦率のように小数を保持する値は`numeric(20, 6)`など用途別のscaleを明示する。
Drizzleは`numeric`にprecision、scale、`number`または`bigint`のmodeを指定できるが、10進小数を`number`へ変換すると正確さを失う可能性がある。
Drizzleの公式sourceでは、既定の`numeric`はdriver値を`string`として扱い、`mode: "number"`と`mode: "bigint"`だけがそれぞれ明示的に変換する。
この種の値は既定の文字列としてRepository境界まで受け取り、十進演算またはDB内演算で金額へ確定してから最小通貨単位へ丸める。
([Drizzle: PostgreSQL column types](https://orm.drizzle.team/docs/column-types)、[Drizzle source: numeric.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/pg-core/columns/numeric.ts))

JavaScriptのsafe integerを超えうる`bigint`も`number`へ変換しない。
APIではJSONがBigIntを直接表現できないため、金額を10進文字列として返すか、安全範囲を契約で保証した整数として返すかをAPI仕様で固定する。

### UUID

主キーにはPostgreSQLの`uuid`を使う。
PostgreSQL 18はUUIDv4とUUIDv7を生成できるが、Hyperdriveの接続先はPostgreSQL 18に限定されない。
Drizzleの`uuid().defaultRandom()`が生成する`gen_random_uuid()`を初期値とし、APIまたはimport処理が生成済みUUIDを渡すことも許容する。
([PostgreSQL: UUID Type](https://www.postgresql.org/docs/current/datatype-uuid.html)、[PostgreSQL: UUID Functions](https://www.postgresql.org/docs/current/functions-uuid.html)、[Drizzle: PostgreSQL column types](https://orm.drizzle.team/docs/column-types))

UUIDは推測困難な識別子としては有用だが、認可の代替にはならない。
すべてのRepositoryクエリはtenantとprojectの所属条件を含める。

### 日付と時刻

WBSの開始日、終了日、status date、作業実績日はPostgreSQLの`date`で保存し、Drizzleでは`date({ mode: "string" })`を使う。
これらは時刻を持たない暦日であり、現行ドメインも`YYYY-MM-DD`を契約にしているためである。

作成時刻、更新時刻、監査イベント時刻、認証時刻は`timestamp with time zone`で保存する。
PostgreSQLはこの値を内部ではUTCとして扱い、出力時にsessionのtimezoneへ変換する。
Drizzleの`timestamp({ withTimezone: true, mode: "string" })`を使えば、JavaScript `Date`へ変換せずデータベースの値を文字列で扱える。
`node-postgres`はJavaScript `Date`へ変換するとPostgreSQLのマイクロ秒をミリ秒へ切り捨てるため、監査時刻の精度を保つ場合にもstring modeが適する。
([PostgreSQL: Date/Time Types](https://www.postgresql.org/docs/current/datatype-datetime.html)、[Drizzle: PostgreSQL column types](https://orm.drizzle.team/docs/column-types)、[node-postgres: Data Types](https://node-postgres.com/features/types))

監査イベントの完全な順序を時刻だけに依存させない。
同一ミリ秒内のイベントや並行書き込みを区別するため、project revisionまたは単調増加する監査sequenceを併用する。

## 階層WBS

WBSは初期実装では**adjacency list**として保存する。
階層を表す`wbs_nodes`と、実行可能な作業を表す`activities`を分離する。
各WBS nodeはnullableな`parent_id`を持ち、ルートだけをNULLにする。
PostgreSQLは同一テーブルを参照するself-referential foreign keyを木構造の表現として公式に例示している。
DrizzleではTypeScriptの循環型推論を避けるため、reference callbackの戻り型を`AnyPgColumn`と明示するか、table-levelの`foreignKey`を使う。
([PostgreSQL: Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)、[Drizzle: Indexes and Constraints](https://orm.drizzle.team/docs/indexes-constraints))

単一の`parent_id REFERENCES wbs_nodes(id)`だけでは、別projectのWBS nodeを親にする誤りを防げない。
`wbs_nodes`に`UNIQUE (tenant_id, project_id, id)`を置き、`(tenant_id, project_id, parent_id)`から同じ複合キーへの外部キーを張る。
同様にtenant境界はprojectの外部キーから辿れるようにし、Repositoryの条件とDB制約の両方で越境を防ぐ。

外部キーは循環を禁止しない。
親変更コマンドは、更新先の親から`WITH RECURSIVE`で祖先または子孫を探索し、自分自身へ戻る変更を拒否する。
PostgreSQLのrecursive CTEは階層データの走査を用途としており、深さ順または経路順を表す補助列も計算できる。
([PostgreSQL: WITH Queries](https://www.postgresql.org/docs/current/queries-with.html))

WBS nodeとactivityの表示順には、それぞれ親子関係とは独立した`sort_order`を持たせる。
初期段階でmaterialized pathやclosure tableを追加する根拠はない。
祖先検索とsubtree取得が実測上のボトルネックになった場合に、読み取りモデルとして検討する。

## トランザクション境界

一つのアプリケーションコマンドによる状態変更と監査ログの追加は、同じ短いトランザクションで確定する。
たとえばactivity更新では、project revisionの確認、activity更新、revision加算、audit event追加を一単位にする。
競合時は古いrevisionを条件にしたUPDATEが0行になるため、HTTPでは409相当の競合として返せる。

Drizzleは`db.transaction`、rollback、nested transactionによるsavepoint、isolation level指定を提供する。
基盤の`node-postgres`では、トランザクション中の全SQLを同じClientで実行する必要がある。
リクエスト内で作った一つのClientからDrizzle transactionを開始すれば、この要件を満たす。
([Drizzle: Transactions](https://orm.drizzle.team/docs/transactions)、[node-postgres: Transactions](https://node-postgres.com/features/transactions))

トランザクション内には必要なSELECTと書き込みだけを置く。
EVM再計算、スケジュール計算、AI提案、外部通知は、入力検証として書き込み前に実行するか、commit後に処理する。
Hyperdriveではトランザクションの継続中にオリジン接続を占有するためである。

## ローカル統合テスト

RepositoryとマイグレーションはSQLiteやmockではなく、実際のPostgreSQLに対して検証する。
型、外部キー、recursive CTE、トランザクション、ロック、numericの挙動はPostgreSQL固有であり、代替DBでは同じ保証を得られない。

ローカルとCIではTestcontainers for Node.jsの`PostgreSqlContainer`を使い、バージョンを固定した公式PostgreSQL imageをテストごとまたはtest suiteごとに起動する。
TestcontainersのPostgreSQL moduleは接続URIを提供し、`pg.Client`による接続例とsnapshot機能を公式に示している。
DrizzleのローカルPostgreSQL手順も、versionを指定したDocker containerへ接続する方法を示している。
CIの実行時間が問題になるまでは、各suiteを空のDBからmigration、seed、testの順に実行して分離性を優先する。
([Testcontainers for Node.js: PostgreSQL](https://node.testcontainers.org/modules/postgresql/)、[Drizzle: Local PostgreSQL setup](https://orm.drizzle.team/docs/guides/postgresql-local-setup))

GitHub ActionsはPostgreSQL service containerも公式にサポートしている。
最初はローカルとCIの経路を揃えられるTestcontainersを採用し、Docker起動時間や並列実行が問題になった場合にCIだけservice containerへ切り替える。
([GitHub Docs: Creating PostgreSQL service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers))

テスト層は次の三段階に分ける。

1. Repository統合テストはNode.jsからコンテナへ直接接続し、全migrationの適用、制約、CRUD、楽観ロック、監査の原子性を検証する。
2. Worker統合テストは`wrangler dev`の`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`をコンテナへ向け、HonoからRepositoryまでを検証する。
3. deploy前の限定的なremote smoke testは`wrangler dev --remote`またはpreview環境で、Hyperdrive固有のpoolingとcaching-disabled設定を検証する。

ローカルの`wrangler dev`は`localConnectionString`へ直接接続するため、Hyperdriveのpoolingとquery cacheを再現しない。
`wrangler dev --remote`はCloudflare上のWorkerと配備済みHyperdriveを使うが、接続先への書き込みが実データへ作用する。
したがって、remote smoke testには本番とは別のdatabaseとHyperdrive configurationを割り当てる。
([Cloudflare: Local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/))

## Issue #4の実装判断

Issue #4では次の方針を採用する。

- `pg@>8.16.3`と`drizzle-orm/node-postgres`を使い、ClientをWorker invocation内で生成する。
- schemaとmigration SQLをversion管理し、本番migrationをWorkerリクエストから実行しない。
- 最初のHyperdrive bindingはquery cachingを無効にする。
- IDは`uuid`、WBS日付は`date`、監査時刻は`timestamptz`、工数は整数分、通貨額は最小通貨単位の`bigint`とする。
- 小数の単価と率だけにscale付き`numeric`を使い、JavaScript `number`へ暗黙変換しない。
- WBSは複合self foreign keyを持つadjacency listとし、親変更時の循環をrecursive CTEで検証する。
- commandの更新、revision、audit eventを一つの短いtransactionに入れる。
- Testcontainers上の実PostgreSQLでmigrationとRepositoryを検証し、Worker local testとHyperdrive remote smoke testを分ける。

## 実装時に追加で確定する事項

次の値はプロダクト要件または接続先PostgreSQLが決まってから固定する。

- 対応通貨ごとの最小通貨単位と、通貨をまたぐprojectを許可するか。
- 小数単価と配賦率に必要なprecisionおよびscale。
- PostgreSQL providerとversion。UUIDv7は全候補で利用できるとは限らない。
- Hyperdriveのオリジン接続数。database providerの接続上限を確認して設定する。
- audit sequenceをproject単位のrevisionで兼ねるか、独立したbigint identityにするか。
