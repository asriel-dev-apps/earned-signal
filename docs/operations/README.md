# VECTA 運用ガイド

このディレクトリは、公開ベータ環境を変更、監視、復旧する担当者向けの Runbook である。
手順中の `production` やリソース名は例ではなく役割名であり、実環境の構成を Cloudflare と PostgreSQL 提供者の管理画面で照合してから実行する。

## システム境界

| 構成要素 | 実行基盤 | 永続データ | 主な障害の影響 |
| --- | --- | --- | --- |
| Web、REST API、MCP | `vecta` Worker | PostgreSQL | UI、API、MCP が利用できない |
| 要員割当提案 | `vecta-optimizer` Worker、Workflow、Container、Workers AI | PostgreSQL の提案、実行、監査レコード | 新しい提案が完了しない |
| 予測シミュレーション | `vecta-simulator` Worker、Queue、DLQ、Container | PostgreSQL の予測実行、結果、監査レコード | 新しい予測が完了しない |
| 接続プール | Cloudflare Hyperdrive | 接続情報のみ | 三つの Worker が PostgreSQL に接続できない |
| System of Record | PostgreSQL | テナント、WBS、EVM、監査、非同期処理 | 読み書きと非同期処理が停止する |
| 認証 | 外部 OIDC Provider | Provider 側 | 保護された API と MCP を利用できない |

PostgreSQL が System of Record であり、Queue、Workflow、Container は復元元ではない。
Worker のロールバックは PostgreSQL スキーマ、Queue 内のメッセージ、Workflow インスタンス、Container の状態を巻き戻さない。

## Runbook

- [リリースとロールバック](release-and-rollback.md)
- [PostgreSQL のバックアップと復旧](postgres-recovery.md)
- [監視とアラート](monitoring-and-alerts.md)
- [非同期処理のインシデント対応](async-processing-incidents.md)
- [公開ベータ開始チェックリスト](public-beta-go-live.md)
- [OIDC と秘密情報のローテーション](../security/identity-and-secrets.md)
- [プライバシーとデータライフサイクル](../security/privacy-and-data-lifecycle.md)

## 変更管理

本番変更には、変更責任者、承認者、Git commit、Worker version ID、データベース migration、開始時刻、終了時刻、検証結果、ロールバック判断を一つの変更記録に残す。
アクセストークン、データベース資格情報、秘密値、顧客データは変更記録とチャットに貼り付けない。

Runbook のコマンドは資格情報を引数に含めない。
認証には短命な workload identity、提供者の対話的ログイン、または標準入力を使い、シェル履歴とプロセス一覧に秘密値を残さない。

## 外部仕様

- [Cloudflare Workers の versions と deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Cloudflare Queues の設定](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Cloudflare Workflows の observability](https://developers.cloudflare.com/workflows/observability/)
- [Cloudflare Containers の observability](https://developers.cloudflare.com/containers/observability/)
- [PostgreSQL の pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [PostgreSQL の continuous archiving と PITR](https://www.postgresql.org/docs/current/continuous-archiving.html)
