# Application context

The Application context is the common mutation and use-case boundary for Web, REST, and MCP. Commands validate project invariants before returning a new immutable state. Adapter-specific validation must not replace these guarantees.

Current commands add, update, and delete leaf work packages. Persistence, authorization, idempotency, optimistic concurrency, and auditing will be added around this boundary rather than duplicated in adapters.
