# 監視とアラート

## 監視の原則

公開ベータ開始前に、availability、latency、error、saturation の基準値を staging と synthetic traffic から取得する。
この文書は測定対象を定義するが、実測していない SLO、閾値、復旧時間を主張しない。

各アラートには owner、severity、通知先、評価窓、閾値、Runbook、maintenance window の扱いを設定する。
閾値は初期観測値、顧客影響、Cloudflare と PostgreSQL の制限から決め、変更理由を記録する。

## 必須シグナル

| 境界 | シグナル | 相関に使う情報 | 対応先 |
| --- | --- | --- | --- |
| Web、REST、MCP | request count、5xx、401/403、latency、CPU time、uncaught exception | Worker version、route、HTTP status、request ID | [リリースとロールバック](release-and-rollback.md) |
| PostgreSQL、Hyperdrive | connection error、pool saturation、query latency、deadlock、storage、replication/backup state | database、operation、SQLSTATE | [PostgreSQL のバックアップと復旧](postgres-recovery.md) |
| Forecast Queue | backlog、oldest message age、delivery attempt、consumer error、DLQ delivery | queue、run ID、Worker version | [非同期処理](async-processing-incidents.md) |
| Staffing Workflow | queued/running/failed/terminated instance、step retry、step duration | proposal ID、instance ID、step、Worker version | [非同期処理](async-processing-incidents.md) |
| Containers | startup failure、health check、instance count、request failure、duration | container class、request/run ID、image version | [非同期処理](async-processing-incidents.md) |
| OIDC | JWKS fetch failure、invalid issuer/audience、401/403 の変化 | issuer、audience class、error code | [OIDC と秘密情報](../security/identity-and-secrets.md) |
| 製品状態 | `REQUESTED`/`RUNNING` の滞留、`FAILED` の増加、audit revision gap | tenant ID、project ID、run/proposal ID | 対応する非同期処理または database Runbook |

ログへ access token、Authorization header、OIDC subject、顧客入力、WBS 名、Scenario 内容、database URL を出力しない。
識別が必要な場合は内部 UUID と request ID を使い、閲覧権限と retention を制限する。

## Dashboard と alert の検証

Cloudflare Dashboard の Worker Logs、Queues、Workflows、Containers と PostgreSQL 提供者の metrics を同じ時刻範囲で確認できる dashboard を用意する。
Worker の `observability.enabled` はログ取得の前提であり、アラート設定や長期保管を自動では作らない。

公開ベータ前に次の synthetic failure を staging で発生させ、通知から Runbook 到達までを確認する。

- 存在しない audience の token による 401。
- 接続不能な staging database による Worker 5xx。
- simulator の一時失敗による Queue retry。
- simulator の恒久失敗による Forecast Run の `FAILED`。
- optimizer の失敗による Workflow step retry と Proposal の `FAILED`。

本番で顧客データを使って alert test を行わない。

## 診断時の読み取り

リアルタイム tail は incident の時間に限定し、出力を issue やチャットへ転記しない。

```sh
pnpm --dir apps/web exec wrangler tail --env production --format json
pnpm --dir apps/optimizer exec wrangler tail --env production --format json
pnpm --dir apps/simulator exec wrangler tail --env production --format json
```

Workflow instance と Queue の操作は、対象 account と environment を確認した operator だけが行う。
診断のために Queue を purge したり、Workflow を terminate したりしない。

参照：[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/)、[Workflows metrics](https://developers.cloudflare.com/workflows/observability/metrics-analytics/)
