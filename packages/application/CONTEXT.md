# Application context

The Application context is the common mutation and use-case boundary for Web, REST, and MCP. Commands validate project invariants before returning a new immutable state. Adapter-specific validation must not replace these guarantees.

Current commands add, update, and delete leaf work packages. Project state validates WBS parent membership and cycles, calendar references, multiple typed dependencies, and scheduling constraints. ProjectCommandService is the shared Web, REST, and MCP use-case boundary. Its ProjectCommandUnitOfWork port surrounds validation with persistence, canonical idempotency, optimistic concurrency, and auditing; adapters must not duplicate those rules.

ProjectCommandAuthorizer is the shared authorization boundary. Human project owners/editors may mutate Current; viewers may not. Agent identities may directly write only progress and actuals when the required scope exists in both their stored grant and signed access token. Agent plan changes require a later human-approval flow and are never applied directly. A successful authorization returns the stable internal principal ID used as the AuditActor.
