# Application context

The Application context is the common mutation and use-case boundary for Web, REST, and MCP. Commands validate project invariants before returning a new immutable state. Adapter-specific validation must not replace these guarantees.

Current commands add, update, and delete leaf work packages and Resources, and atomically replace all Assignments for one work package. Project state validates WBS parent membership and cycles, calendar references, multiple typed dependencies, scheduling constraints, Skills, Resources, and Assignments. ProjectCommandService is the shared Web, REST, and MCP use-case boundary. Its ProjectCommandUnitOfWork port surrounds validation with persistence, canonical idempotency, optimistic concurrency, and auditing; adapters must not duplicate those rules.

ProjectCommandAuthorizer is the shared authorization boundary. Human project owners/editors may mutate Current; viewers may not. Agent identities may directly write only progress and actuals when the required scope exists in both their stored grant and signed access token. Agent plan changes require a later human-approval flow and are never applied directly. A successful authorization returns the stable internal principal ID used as the AuditActor.

## Language

- **Owner**: the accountable label on a work package; it does not reserve capacity.
- **Assignment replacement**: one command that supplies the complete desired Assignment set for a work package, including an empty set to clear it.
- **Plan change**: a Current mutation other than progress or actual recording; Resource and Assignment commands are plan changes.
