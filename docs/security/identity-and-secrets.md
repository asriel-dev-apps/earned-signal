# OIDC と秘密情報のローテーション

## 信頼境界

REST token は設定済み `OIDC_AUDIENCE`、MCP token は canonical `MCP_RESOURCE_URL` を audience として検証する。
両者は同じ token とみなさない。
issuer と subject は PostgreSQL の principal に解決され、tenant claim だけでは認可されない。

人間の role は tenant membership と project membership で決まり、agent は project membership に加えて許可された scope を必要とする。
OIDC Provider 側の group だけで VECTA の project access が付与されたと判断しない。

## 秘密情報の保管

次の値を Git、Wrangler の平文 `vars`、`.env` の共有、CI log、issue、チャットへ保存しない。

- PostgreSQL password または password を含む接続 URL。
- OIDC client secret、private key、refresh token、access token。
- Cloudflare API token と account recovery credential。
- backup の復号鍵。

Cloudflare binding ID、OIDC issuer URL、audience、JWKS URL、MCP resource URL は通常は秘密値ではない。
ただし環境の識別情報なので、production と staging の対応は変更管理の対象にする。

実行時 secret は Cloudflare Secrets Store または Worker secret、CI では environment-scoped secret と short-lived federation を使う。
操作担当者は least privilege の短命な identity を使い、共有 account を使わない。

## OIDC signing key

OIDC Provider の signing key は、JWKS に旧 key と新 key を同時掲載できる overlap rotation を使う。

1. 新しい signing key を Provider 内で生成し、private key を外へ出さない。
2. 新旧 public key が JWKS に掲載され、異なる `kid` を持つことを確認する。
3. staging で新 key の REST token と MCP token を別々に検証する。
4. production で新 key による発行を開始する。
5. 旧 key で署名された token の最大寿命と clock skew を超えてから旧 public key を外す。
6. 401、JWKS fetch failure、unknown `kid` を監視し、変更記録を閉じる。

緊急失効では overlap を待たず旧 key を外すため、既存 session が失敗する影響を incident record に残す。

## OIDC client と agent credential

新しい client credential を作成し、staging、production の順に consumer を切り替え、旧 credential の利用がないことを Provider log で確認してから失効する。
secret の値ではなく Provider 上の credential ID と有効期間を記録する。

agent access を失効する場合は、Provider credential の失効と PostgreSQL principal の `disabled_at`、project membership、allowed scope を両方確認する。
片方だけでは、別 credential または残った membership からアクセスできる可能性がある。

## PostgreSQL と Hyperdrive

database credential の交換は新しい database role または password を発行し、新しい Hyperdrive configuration で接続確認してから Worker binding を切り替える。
接続 URL を Wrangler command の引数や shell history に入れない。
Cloudflare Dashboard の secret input または承認済みの秘密管理連携から設定する。

1. 新 credential に旧 credential と同じ最小権限を付与する。
2. staging 相当の Worker から health と read-only query を確認する。
3. production の三つの Worker binding を計画した順で切り替える。
4. API、Workflow、Queue consumer の database error がないことを確認する。
5. connection drain 後に旧 credential を失効し、利用試行を監視する。

## Cloudflare operator credential

Cloudflare API token は account 全体の global key を使わず、対象 account、Worker、Queue、Workflow、必要な read/write action に限定する。
交換時は CI environment に新 token を登録し、read-only command と staging deploy を確認してから production deploy job を切り替える。
旧 token を失効し、audit log で利用が止まったことを確認する。

## 漏えい対応

漏えいの疑いがある場合は対象 credential ID、到達可能な tenant と resource、最初と最後の利用時刻を特定する。
値そのものを検索結果や incident record に転記しない。
credential を失効し、同じ権限を持つ session と派生 token を無効化し、Cloudflare、OIDC、PostgreSQL、Application audit を照合する。

ローテーション完了条件は、新 credential の動作だけではない。
旧 credential が失効し、利用試行が監視され、不要な権限が除去されて初めて完了する。
