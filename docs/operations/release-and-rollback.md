# リリースとロールバック

## リリース単位

一つのリリースは、Git commit、三つの Worker version ID、Container image、データベース migration の組で識別する。
「直前の Git commit」だけでは、実際に配信中の Worker と Container を特定できない。

データベース変更は原則として後方互換な拡張、アプリケーション切替、不要構造の削除という複数リリースに分ける。
Worker のロールバックは migration を戻さないため、同じスキーマで旧版と新版の双方が動く期間を設ける。

`.github/workflows/deploy.yml` の環境別 job が migration の実行境界である。
GitHub Environment の直列化に加え、`packages/persistence/scripts/migrate.mjs` が接続先 host/database の一致を確認し、PostgreSQL advisory lock を取得してから Drizzle migration を適用する。
実行履歴は Git commit、GitHub Actions run、environment、Drizzle migration journal を対応付けて変更記録へ残す。
production migration を手元の一時的な JavaScript や SQL の loop で実行しない。

## GitHub Environment の設定

配備 workflow は `staging` を必ず先に実行し、`production` を選んだ場合だけ staging 成功後に production job を開始する。
各 GitHub Environment に次を登録し、production には required reviewer を設定する。

- Secrets: `CLOUDFLARE_API_TOKEN`、`DATABASE_URL`。
- Environment variables: `CLOUDFLARE_ACCOUNT_ID`、`OIDC_ISSUER`、`OIDC_AUDIENCE`、`OIDC_JWKS_URL`、`MCP_RESOURCE_URL`、`DATABASE_HOST`、`DATABASE_NAME`、`BASE_URL`、`BACKUP_RESTORE_EVIDENCE_URL`、`BACKUP_RESTORE_VERIFIED_AT`、`MONITORING_EVIDENCE_URL`、`ALERT_DRILL_VERIFIED_AT`。
- Repository variables: `STAGING_HYPERDRIVE_ID`、`PRODUCTION_HYPERDRIVE_ID` と、各環境を接頭辞にした `PRE_AUTH_RATE_LIMIT_NAMESPACE_ID`、`AUTH_RATE_LIMIT_NAMESPACE_ID`、`COMPUTE_RATE_LIMIT_NAMESPACE_ID` の計八つ。deploy gate は両環境の Hyperdrive と六つの rate-limit namespace がすべて分離されていることを比較する。

Cloudflare token は三つの Worker、Workflow、Queue、Container、Hyperdriveを対象環境内で配備するための最小権限に限定する。
`DATABASE_HOST` と `DATABASE_NAME` は秘密値ではなく、migration が `DATABASE_URL` の接続先を誤らないための独立した確認値である。
三つの rate-limit namespace ID は正の整数かつ相互に異なり、Cloudflare account 内の他の binding とも重複させない。
backup restore と alert drill の証跡 URL は資格情報を含まない HTTPS URL とし、確認時刻は直近90日以内に更新する。deploy gate は証跡の内容を推測せず、期限切れまたは未登録なら配備を停止する。

## リリース前の確認

次の条件を満たさないリリースは開始しない。

- main の対象 commit がレビュー済みで、CI、依存関係監査、リポジトリの security scan が成功している。
- staging と production が別の OIDC client、Hyperdrive、Queue、DLQ、Workflow、Worker 名を使う。
- Wrangler 設定に `example.invalid`、全桁ゼロの resource ID、開発用 Origin が残っていない。
- PostgreSQL 提供者の PITR が有効で、最新の復旧演習が記録されている。
- migration の forward path と旧 Worker との互換性がレビュー済みである。
- production migration job の接続先、排他実行、監査記録を staging で検証している。
- リリース責任者が直前の正常な Worker version ID を記録している。

ローカルの静的な構成検査は、Wrangler の環境名を環境変数で渡して実行する。
別の設定ファイルを使う構成だけ、三つの config path を上書きする。

```sh
VECTA_ENV=production node scripts/verify-beta-readiness.mjs
```

この検査は Cloudflare、OIDC、PostgreSQL の実リソースを照合しない。
成功はリリース承認の代わりにならない。

## 配信順序

まず staging で同じ commit と migration を配信し、[公開ベータ開始チェックリスト](public-beta-go-live.md)の smoke test を実行する。
production では次の順序を守る。

1. PostgreSQL の復元可能時点と schema version を変更記録に残す。
2. 後方互換な migration を一度だけ適用し、migration 管理テーブルと期待した制約を確認する。
3. `vecta-optimizer-production` を配信し、Workflow と Staffing Solver Container を確認する。
4. `vecta-simulator-production` を配信し、Queue consumer、DLQ consumer、Forecast Simulator Container を確認する。
5. `vecta-production` を最後に配信し、REST API と MCP が新しい非同期処理を起動できる状態にする。
6. 読み取り専用 smoke test の後、専用の synthetic tenant で `scripts/beta-e2e.mjs` を実行し、WBS 更新、Scenario、要員提案、予測、REST、MCP を確認する。
7. Worker version ID、Container rollout、検証結果を変更記録へ追記する。

各 Worker の配信ではリポジトリに固定した Wrangler を使う。
`RELEASE_TAG` に秘密値を含めない。

```sh
pnpm --dir apps/optimizer exec wrangler deploy --env production --strict --containers-rollout gradual --tag "$RELEASE_TAG"
pnpm --dir apps/simulator exec wrangler deploy --env production --strict --containers-rollout gradual --tag "$RELEASE_TAG"
pnpm --dir apps/web build --mode production
pnpm --dir apps/web exec wrangler deploy --strict --tag "$RELEASE_TAG"
```

Web は Vite mode から `vite.config.ts` が `CLOUDFLARE_ENV` を選び、Cloudflare Vite Plugin が named environment を平坦化した Worker bundle と静的 asset directory を `.wrangler/deploy/config.json` に生成するため、build 後の deploy に `--env` を重ねない。workflow は Vite mode を明示して環境の取り違えを防ぐ。
環境別 config を別ファイルにする場合は、レビュー済みの `--config` を各コマンドへ追加する。
Cloudflare Dashboard で本番設定だけを変更すると、リポジトリの設定と実環境が分岐するため、緊急変更も事後にコードへ反映する。

## ロールバック判断

認証不能、テナント境界違反、データ破損、書き込み失敗の増加、全リクエストの失敗は直ちに変更停止と影響範囲確認を行う。
性能や一部の非同期処理の劣化は、負荷の停止、Queue delivery の一時停止、旧版への切替のどれがデータ整合性を保つかを incident commander が判断する。

ロールバック前に次を確認する。

- 旧版が現在の PostgreSQL schema と Queue message contract を読める。
- 対象期間に Durable Object migration または削除済み binding がない。
- 旧 Container image が現在の Workflow step と simulator request contract に対応する。
- 進行中の Workflow と Queue message を旧版が安全に再実行できる。

配信中の version を確認し、明示した version ID へ戻す。

```sh
pnpm --dir apps/web exec wrangler versions list --env production --json
pnpm --dir apps/web exec wrangler rollback "$KNOWN_GOOD_WEB_VERSION" --env production --message "incident rollback"
```

同じ手順を影響を受けた Worker にだけ適用する。
version ID は資格情報ではないが、誤った環境の ID を使わないよう変更記録からコピーする。

Container を含む Worker の rollback が platform resource の変更により拒否された場合、古い Git commit をそのまま再配信しない。
現在の binding と schema に対応する修正版を新しい version として配信する。

## ロールバック後

smoke test、synthetic tenant、エラー率、PostgreSQL の書き込み、Queue backlog、DLQ、Workflow failure を再確認する。
予測実行と要員提案は PostgreSQL の terminal status と監査レコードを確認し、見た目上の Worker 成功だけで完了と判断しない。

参照：[Cloudflare Workers rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
