# EarnedSignal セキュリティ運用

このディレクトリは、公開ベータで必要な identity、秘密情報、privacy、retention の運用判断を記録する。
製品の認可モデルは [OIDC project authorization ADR](../adr/0002-oidc-project-authorization.md)、具体的な運用は次の Runbook に従う。

- [OIDC と秘密情報のローテーション](identity-and-secrets.md)
- [プライバシーとデータライフサイクル](privacy-and-data-lifecycle.md)

security incident では資格情報を issue、チャット、ログ、コマンド引数へ貼り付けない。
漏えいが疑われる値は内容を確認してからではなく、識別子だけを記録して失効、交換する。
