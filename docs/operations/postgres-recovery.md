# PostgreSQL のバックアップと復旧

## 復旧戦略

本番の主要な復旧手段は、PostgreSQL 提供者が管理する暗号化済みの物理バックアップと **Point-in-Time Recovery（PITR）** である。
PITR の保持期間、復旧可能な最古時点、暗号鍵、リージョン、復旧手順は提供者の契約と実設定から記録する。
このリポジトリはそれらの値を保証しない。

`pg_dump` による論理バックアップは、PITR とは独立した復旧演習と長期保全に使う。
論理バックアップだけでは WAL による任意時点復旧を代替できない。

## バックアップ対象

EarnedSignal の PostgreSQL database 全体を一つの整合した単位として扱う。
テーブルは `tenant_id` で分離されているが、tenant、principal、membership、project、baseline、audit、Scenario、Proposal、Forecast の外部キーが相互に関係する。
テーブル単位または `tenant_id` 条件付きの `pg_dump` は、復元可能なテナントバックアップにはならない。

テナント単位の export は DSAR 用の製品機能として生成し、災害復旧用バックアップと分ける。
復旧時に別テナントの行を削除して目的のテナントだけを残す操作は、本番 database 上で行わない。

## 論理バックアップ

バックアップ作業用 identity には読み取りと `pg_dump` に必要な最小権限だけを付与する。
パスワードはコマンド引数、接続 URL、`.pgpass`、シェル履歴、ログに残さず、短命な provider identity または対話的な標準入力で与える。

平文の dump をディスクに書かず、`pg_dump` の custom format を保管先の公開暗号鍵で直ちに暗号化する。
次の例の `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER` は秘密値を含まない接続属性である。

```sh
umask 077
export PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE=verify-full
pg_dump --format=custom --no-owner --no-acl --verbose=0 \
  | age --recipients-file ops-backup-recipients.txt \
  > "earned-signal-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
```

暗号化された object は、versioning、retention lock、アクセス監査を有効にした production database とは別の security boundary に保存する。
保持世代は法的要件、顧客契約、復旧目標、費用から owner が決め、実際の lifecycle policy と変更記録を照合する。
未決定の保持日数を Runbook の既定値として扱わない。

バックアップ完了時に、暗号化 object の size、cryptographic digest、database identifier、開始終了時刻、PostgreSQL major version、schema migration、保管先 object version を記録する。
秘密値と顧客データの内容は記録しない。

## 復旧演習

復旧演習は本番とは別の account または network boundary にある空の database で行う。
復旧先の identity と Hyperdrive は本番 Worker から到達できない状態にする。

1. 対象バックアップの digest と暗号化を検証する。
2. 復旧先 PostgreSQL の major version と extension を確認する。
3. 空の database を作成し、本番資格情報を使わずに接続する。
4. 暗号化 object を標準出力へ復号し、`pg_restore` の標準入力へ渡す。
5. restore error が一件でもあれば演習を失敗として扱う。
6. migration 管理テーブル、table count、外部キー、主要な tenant ごとの project count を照合する。
7. synthetic tenant だけを使って workspace、Baseline、audit、Scenario、Proposal、Forecast の参照を検証する。
8. 復旧環境と復号プロセスを破棄し、結果と所要時間を記録する。

```sh
umask 077
export PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE=verify-full
age --decrypt "earned-signal-backup.dump.age" \
  | pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname="$PGDATABASE"
```

復旧先 database 名は秘密値ではない。
`PGPASSWORD` の export や password を含む database URL は使わず、短命な identity または対話的認証を使う。

## PITR

PITR は元の database を上書きせず、新しい database instance または provider project に復元する。
復旧時点は、最初の破壊的操作より前で、最後の正常な監査イベントと整合する時刻を選ぶ。

復元後は次の順序で切り替える。

1. すべての書き込みを止め、元 database の最終 transaction 時刻を記録する。
2. 新しい database で schema、tenant 数、project 数、最新 audit revision、非同期処理 status を検証する。
3. 新しい Hyperdrive configuration を作成し、staging Worker から接続確認する。
4. production Worker の binding を変更し、read-only smoke test を行う。
5. 書き込みを再開し、最初の command と audit event の revision を確認する。
6. 元 database は保持ポリシーに従って隔離し、即時削除しない。

PITR 後は、復旧時点より後に外部へ返した成功応答と database の状態がずれる可能性がある。
`command_receipts`、audit events、OIDC provider の access log、顧客報告を照合し、失われた操作を自動で再送しない。

参照：[PostgreSQL backup and restore](https://www.postgresql.org/docs/current/backup.html)
