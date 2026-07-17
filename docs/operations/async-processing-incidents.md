# 非同期処理のインシデント対応

## 最初の切り分け

新しい要員提案が止まった場合は Workflow、Staffing Solver Container、PostgreSQL の順に確認する。
新しい予測が止まった場合は Forecast Queue、Simulator Worker、Forecast Simulator Container、DLQ、PostgreSQL の順に確認する。

どちらも PostgreSQL の status と audit event が製品上の結果である。
Cloudflare 上で処理が終了していても、`staffing_proposals` または `forecast_runs` が terminal status でなければ完了していない。

## Forecast Queue

通常 Queue `earned-signal-<environment>-forecast-runs` は一時失敗を retry し、上限に達した message を `earned-signal-<environment>-forecast-runs-dlq` へ送る。
現在の DLQ consumer は対応する Forecast Run を `FAILED` として確定するため、DLQ は再実行待ちの保管場所ではない。

backlog または oldest message age が alert threshold を超えた場合は次を行う。

1. Web Worker の enqueue 成功と `forecast_runs.status = 'REQUESTED'` を照合する。
2. Simulator Worker の error、delivery attempt、Hyperdrive error、Container startup と `/health` を確認する。
3. 同じ run ID が `READY` または `FAILED` なら再送しない。
4. contract error、stale revision、missing run は恒久失敗として修正対象を記録する。
5. PostgreSQL や Container の一時障害なら consumer を復旧し、Queue retry に任せる。

障害拡大を止める必要がある場合は delivery を一時停止する。
producer は停止しないため backlog は増える。

```sh
FORECAST_QUEUE_NAME=earned-signal-production-forecast-runs
pnpm --dir apps/simulator exec wrangler queues pause-delivery "$FORECAST_QUEUE_NAME"
pnpm --dir apps/simulator exec wrangler queues resume-delivery "$FORECAST_QUEUE_NAME"
```

Queue purge は未処理 message を不可逆に削除し、in-flight message まで完全には止めない。
本番では incident commander と data owner が、対象 run を database 上で terminal status にする手順と顧客通知を承認した場合に限る。

## DLQ

DLQ delivery、DLQ consumer error、`FORECAST_RETRIES_EXHAUSTED` を alert 対象にする。
同じ入力の再実行が必要な場合は、元 message をコピーして Queue へ投入しない。
利用者または権限を持つ operator が、現在の project revision と Scenario revision から新しい Forecast Run ID を作成する。
この方法なら idempotency、revision pin、監査イベントが保たれる。

## Staffing Workflow

Workflow failure の場合は instance timeline で `mark proposal running`、`solve and verify staffing proposal`、保存 step のどこで失敗したかを確認する。
solver step と保存 step にはコード上の retry があり、手動で同じ Proposal を並行実行すると二重処理になる可能性がある。

1. Proposal ID と Workflow instance ID を変更記録へ残す。
2. PostgreSQL の Proposal status、base revision、latest run、linked Scenario を読み取る。
3. Container health、Hyperdrive、Workers AI error、Workflow step attempts を確認する。
4. Proposal が terminal status なら instance を再実行しない。
5. `REQUESTED` または `RUNNING` のまま残る場合は、原因修正後に製品の新規提案フローから別 ID で再作成する。

Workflow の terminate は実行を止めるが、すでに完了した step と PostgreSQL 書き込みを戻さない。
terminate 後に Proposal status を手作業で更新せず、監査可能な Application command または専用の修復手順を実装してから処置する。

## Container

Container startup、port readiness、health endpoint、image rollout、instance limit を確認する。
Staffing Solver と Forecast Simulator は request ごとに PostgreSQL を直接更新せず、呼び出し元 Worker が結果を検証して保存する。
したがって Container の再起動だけで失われた結果を復元できないが、重複した database 書き込みを Container が行うこともない。

Container image の rollback は Worker contract と組で判断する。
旧 image が新しい request を読めない場合は、新しい互換 image を配信する。

## 収束確認

incident を閉じる前に次を確認する。

- Queue backlog と oldest message age が平常範囲へ戻った。
- DLQ delivery と consumer error が止まった。
- Workflow failure と step retry が平常範囲へ戻った。
- synthetic tenant の新しい Proposal と Forecast が terminal status になった。
- `REQUESTED` または `RUNNING` の孤立レコードを tenant ごとに調査した。
- 顧客影響、失敗した ID、再作成した ID、監査結果を incident record に残した。

参照：[Cloudflare Queue の DLQ](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)、[Queue の pause と purge](https://developers.cloudflare.com/queues/configuration/pause-purge/)
