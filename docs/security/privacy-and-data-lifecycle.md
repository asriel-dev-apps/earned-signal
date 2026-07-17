# プライバシーとデータライフサイクル

## データ分類

EarnedSignal は、identity、membership、WBS、Resource、Assignment、worklog、cost、Baseline、Scenario、Proposal、Forecast、audit event を PostgreSQL に保存する。
表示名、Resource 名、作業記録には個人を識別できる情報が含まれる可能性がある。
自由入力欄には不要な機微情報を入力しないという製品上の案内と契約上の制限を設ける。

ログ、backup、support export、監視サービスにも personal data が複製され得る。
database だけを削除して DSAR が完了したと判断しない。

## データ所在台帳

公開ベータ開始前に次の所在と owner を data inventory に登録する。

| 所在 | 内容 | 削除方法の証跡 |
| --- | --- | --- |
| PostgreSQL | 製品データ、membership、audit、非同期結果 | transaction と audit record |
| PostgreSQL backup、PITR | database 全体 | provider retention と expiry record |
| Cloudflare Worker Logs | request/error metadata | Logpush または dashboard retention 設定 |
| Queue、DLQ、Workflow | 処理 payload と実行 metadata | terminal status、retention、instance record |
| support system | 顧客が提供した画面、export、問い合わせ | ticket deletion record |
| OIDC Provider | subject、session、sign-in log | Provider audit record |

## 保持期間

保持期間はデータ分類ごとに、提供目的、契約、会計、security、法的義務から data owner と法務担当が承認する。
未承認の日数をコードやこの文書の既定値として採用しない。

少なくとも次を別々に決める。

- active tenant の製品データ。
- 契約終了後の猶予期間と削除期限。
- audit event と command receipt。
- Worker、OIDC、database access log。
- Queue、DLQ、Workflow metadata。
- 論理 backup と PITR。
- support attachment と DSAR export。

保持設定を短くすると復旧可能期間と不正調査期間が変わる。
変更時は privacy だけでなく recovery と security の owner も承認する。

## DSAR

DSAR は requester の identity と tenant authority を検証し、request ID、対象者、対象 tenant、期限、検索範囲、承認者を記録する。
本人確認資料を製品 database や一般の issue に保存しない。

access または portability request では、対象 tenant の権限を検証した専用 export を生成する。
raw database dump は他の subject、tenant、internal identifier、secret を含むため渡さない。

correction request は通常の監査可能な command で処理する。
audit event を直接書き換えて履歴を消さない。

deletion request では次の順序で範囲を確定する。

1. 契約、法的保留、会計、security incident による保持義務を確認する。
2. principal と Resource が同一人物か、複数 tenant に所属するかを確認する。
3. active data、derived result、log、support copy、backup を所在台帳から列挙する。
4. 製品上の削除または匿名化を tenant boundary 内の transaction で行う。
5. backup は改変せず、通常の retention expiry まで復元時再削除リストで管理する。
6. 完了した所在、例外、expiry を request record に残す。

PostgreSQL の cascade は参照整合性を保つ仕組みであり、法的な削除範囲を自動で決定しない。

## Subprocessor

公開ベータ時点で利用する subprocessor を、目的、処理データ、region、transfer mechanism、retention、security contact、削除方法とともに台帳化する。
少なくとも Cloudflare、PostgreSQL 提供者、OIDC Provider、監視、support、backup 保管先、メール配信、AI provider の実利用を確認する。

Workers AI を含む AI service へ送る payload はコードと実環境の双方で確認する。
説明生成に必要な検証済みの事実だけを送り、access token、database credential、不要な個人情報を送らない。

subprocessor の追加または処理目的の変更は、契約と privacy notice の更新要否を確認してから production へ配信する。
