# Application context

The Application context is the common mutation and use-case boundary for Web, REST, and MCP. Commands validate project invariants before returning a new immutable state. Adapter-specific validation must not replace these guarantees.

Current commands add, update, and delete leaf work packages and Resources, atomically replace all Assignments for one work package, and publish Current as a named immutable Baseline version. Project state validates WBS parent membership and cycles, calendar references, multiple typed dependencies, scheduling constraints, Skills, Resources, and Assignments. ProjectCommandService is the shared Web, REST, and MCP use-case boundary. Its ProjectCommandUnitOfWork port surrounds validation with persistence, canonical idempotency, optimistic concurrency, and auditing; adapters must not duplicate those rules.

ProjectCommandAuthorizer is the shared authorization boundary. Human project owners/editors may mutate Current; viewers may not. Agent identities may directly write only progress and actuals when the required scope exists in both their stored grant and signed access token. Agent plan changes require a later human-approval flow and are never applied directly. A successful authorization returns the stable internal principal ID used as the AuditActor.

ProjectQueryAuthorizer permits a provisioned owner, editor, viewer, or agent to read its project while rejecting identities without the tenant/project grant. Query adapters must use it before loading project performance or other project data.

Scenario calculation applies an ordered, plan-only subset of Project Commands to an immutable Current input. It reuses Project validation, scheduling, and capacity calculation, then applies deterministic SPI/CPI factors only to unfinished duration and remaining budget. Scenario commands cannot publish a Baseline or write progress and actuals.

## Language

- **Owner**: the accountable label on a work package; it does not reserve capacity.
- **Assignment replacement**: one command that supplies the complete desired Assignment set for a work package, including an empty set to clear it.
- **Plan change**: a Current mutation other than progress or actual recording; Resource and Assignment commands are plan changes.
- **Project query**: a read-only project operation authorized by tenant/project membership rather than mutation role or agent write scopes.
- **Baseline publish**: a human plan command that freezes the complete Current plan as the next approved, immutable Baseline version.
- **Scenario plan command**: a Task, Resource, or Assignment plan command evaluated in order against an in-memory Scenario without mutating Current.
