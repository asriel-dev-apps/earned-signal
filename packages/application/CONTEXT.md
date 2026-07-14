# Application context

The Application context is the common mutation and use-case boundary for Web, REST, and MCP. Commands validate project invariants before returning a new immutable state. Adapter-specific validation must not replace these guarantees.

Current commands add, update, and delete leaf work packages. ProjectCommandService is the shared Web/REST/future-MCP use-case boundary. Its ProjectCommandUnitOfWork port surrounds validation with persistence, canonical idempotency, optimistic concurrency, and auditing; adapters must not duplicate those rules. Authorization remains outside the service until a verified AuditActor is supplied by the authentication adapter.
