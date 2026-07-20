# 公開ベータ開始チェックリスト

## Go-live 判定

各項目に owner、evidence link、確認時刻を付ける。
未完了項目を「ベータなので許容」として閉じず、risk owner が期限と緩和策を明示して承認する。

### 製品とリリース

- [ ] main の対象 commit、CI、dependency audit、security scan が成功している。
- [ ] staging で WBS 編集、Baseline、EVM、Scenario、Forecast、Staffing Proposal、REST、MCP を確認した。
- [ ] production 用の三つの Wrangler 設定から placeholder と開発 URL を除いた。
- [ ] Worker version、Container image、migration、Git commit の対応を記録した。
- [ ] 排他実行と接続先確認を備えた production migration job を staging で演習した。
- [ ] rollback 対象 version と database 互換性を確認した。

### Identity と tenant boundary

- [ ] OIDC issuer、JWKS、REST audience、MCP resource audience を production 値で確認した。
- [ ] REST token を MCP に、MCP token を REST に使った negative test が失敗する。
- [ ] tenant claim だけでは access できず、principal と membership が必要であることを確認した。
- [ ] OWNER、ADMIN、MEMBER と project OWNER、EDITOR、VIEWER の権限 test を実行した。
- [ ] agent scope と human role を混同しない negative test を実行した。
- [ ] operator、CI、database、backup の credential owner と rotation date を登録した。

### データ保護

- [ ] PostgreSQL の暗号化、network restriction、least-privilege role、TLS verification を確認した。
- [ ] PITR の実設定、復旧可能期間、region、暗号鍵 owner を provider 上で確認した。
- [ ] 暗号化 logical backup を隔離環境へ復元し、証跡と実測所要時間を記録した。
- [ ] tenant data、audit、backup、log、support data の retention を承認した。
- [ ] DSAR の本人確認、export、correction、deletion、backup 再削除手順を演習した。
- [ ] subprocessor 台帳、契約、privacy notice、security contact を確認した。

### Cloudflare と非同期処理

- [ ] production と staging の Hyperdrive、Queue、DLQ、Workflow、Worker、OIDC client が分離されている。
- [ ] Forecast Queue の retry、DLQ delivery、DLQ consumer による `FAILED` 確定を staging で確認した。
- [ ] Workflow step retry、terminal Proposal、linked Scenario を staging で確認した。
- [ ] Staffing Solver と Forecast Simulator の Container health、rollout、instance limit を確認した。
- [ ] Queue pause/resume、Worker rollback、credential rotation の担当者が Runbook を演習した。

### 監視と incident response

- [ ] API、MCP、PostgreSQL、Queue、DLQ、Workflow、Container、OIDC の dashboard がある。
- [ ] 実測値と顧客影響から alert threshold を決め、owner、通知先、Runbook を設定した。
- [ ] synthetic failure が alert を発生させ、on-call が Runbook へ到達した。
- [ ] ログに token、Authorization header、database URL、顧客入力が含まれないことを確認した。
- [ ] incident commander、security、privacy、database、Cloudflare、顧客連絡の担当が決まっている。

## 読み取り専用 smoke test

公開 URL を環境変数で渡して、公開 endpoint と保護 endpoint を検証する。
access token は標準入力から読み、引数、環境変数、ファイル、ログへ残さない。

公開 endpoint だけを確認する場合は次を実行する。

```sh
VECTA_BASE_URL=https://service.example node scripts/beta-smoke.mjs </dev/null
```

synthetic tenant の workspace まで確認する場合は、REST audience の短命 access token を対話的に読み取る。

```sh
read -rs BETA_ACCESS_TOKEN
printf '%s' "$BETA_ACCESS_TOKEN" \
  | VECTA_BASE_URL=https://service.example \
    VECTA_TENANT_ID=00000000-0000-4000-8000-000000000001 \
    VECTA_PROJECT_ID=00000000-0000-4000-8000-000000000002 \
    VECTA_AUTH_CHECK=1 \
    node scripts/beta-smoke.mjs
unset BETA_ACCESS_TOKEN
```

この script は GET だけを送り、WBS、Scenario、Proposal、Forecast を変更しない。

書き込み経路は `scripts/beta-e2e.example.json` を一時ファイルへコピーし、専用 synthetic tenant の実在する ID と、人間が確認した全未完了taskのForecast/Staffing見積もりへ置き換えて実行する。
設定ファイルに token を保存してはならない。
`VECTA_E2E_RUN_ID` はリリースごとに新しくし、同じ実行内の REST/MCP 再送だけで idempotency を確認する。

```sh
read -rs REST_ACCESS_TOKEN
read -rs MCP_ACCESS_TOKEN
read -rs RESTRICTED_AGENT_MCP_ACCESS_TOKEN
printf '%s\n%s\n%s\n' "$REST_ACCESS_TOKEN" "$MCP_ACCESS_TOKEN" "$RESTRICTED_AGENT_MCP_ACCESS_TOKEN" \
  | VECTA_BASE_URL=https://service.example \
    VECTA_E2E_CONFIG=/private/tmp/vecta-beta-e2e.json \
    VECTA_E2E_RUN_ID=release-20260717-1 \
    node scripts/beta-e2e.mjs
unset REST_ACCESS_TOKEN MCP_ACCESS_TOKEN RESTRICTED_AGENT_MCP_ACCESS_TOKEN
```

三つ目のtokenは同じsynthetic projectのAGENT principalに対するMCP audience tokenで、progress/actualsのwrite scopeを含めない。
script は REST の更新と再送、stale revision、Baseline、EVM、ScenarioによるCurrent不変、Forecast Queue、linked Scenarioを伴うStaffing Workflow、cross-tenant/project rejection、REST/MCP audience分離、MCP read/update/replay、agent scope不足を確認し、最後にsynthetic Scenarioを破棄する。
Proposal と監査記録は検証証跡として残るため、顧客 tenant では実行しない。

## E2E の記録

E2E では次の結果だけを記録し、token と顧客 payload を残さない。

1. WBS の一行を変更し、revision が増えた。audit actor は database の監査レコードで照合した。
2. Baseline を承認し、Current と Baseline が分離して表示された。
3. 進捗、実績工数、実績費用を入力し、EVM graph と period snapshot が更新された。
4. Scenario を実行し、Current を変えずに差分を表示した。
5. Forecast を実行し、Queue 経由で `READY` または説明可能な `FAILED` になった。
6. Staffing Proposal を実行し、Workflow 経由で terminal status と linked Scenario を得た。
7. REST command の同じ idempotency key を再送し、重複変更が発生しなかった。
8. MCP の read tool と許可された agent command を実行し、REST と同じ認可境界を通った。
9. 別 tenant、別 project、scope 不足、stale revision の操作が拒否された。

Go-live 後も最初の release window は Queue backlog、Workflow failure、database error、401/403、5xx を担当者が継続監視する。
終了時刻は固定値にせず、観測したトラフィック量と alert 状態から incident commander が決める。
