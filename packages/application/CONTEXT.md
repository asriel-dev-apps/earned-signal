# Application context

The Application context is the common mutation and use-case boundary for adapters. Commands validate project invariants before returning a new immutable state. Adapter-specific validation must not replace these guarantees.

Current commands add, update, and delete tasks and members. A task carries the 23 typed worksheet columns natively — the six meta fields, planned effort (L, whole minutes), progress (T, basis points), actual effort (W, whole minutes), the daily planned-value plot, actual start/finish (R/S), an optional member assignee, a `parentId` for the D→F hierarchy, and typed dependencies. Project state validates unique task IDs, non-blank names, whole non-negative L/W, progress within 0–10000, non-negative daily-plan values, an ordered R ≤ S, a valid member assignee, dependency references, and an acyclic parent hierarchy. ProjectCommandService is the shared use-case boundary; its ProjectCommandUnitOfWork port surrounds validation with persistence, canonical idempotency, optimistic concurrency, and auditing.

ProjectCommandAuthorizer is the shared authorization boundary for Current mutations. Human project owners/editors may mutate Current; viewers may not. Agent identities may directly write only progress (`progressBasisPoints`) and actuals (`actualEffortMinutes`) on a single task when the required scope exists in both their stored grant and signed access token. Any other command from an agent is a plan change and is never applied directly. A successful authorization returns the stable internal principal ID used as the AuditActor.

ProjectQueryAuthorizer permits a provisioned owner, editor, viewer, or agent to read its project while rejecting identities without the tenant/project grant. Query adapters must use it before loading project data.

The WBS-grid projection is the read model: it returns one flat row per task with the 23 columns plus the derived effort columns (K/M/N/O/P/Q/U/V/X) and a project rollup (BAC/PV/EV/AC in person-days, plus SV/CV/SPI/CPI), all computed by the shared effort-EVM Domain module with no rounding. The projection is the single choke point for the ⑦ role seam that will later strip role-sensitive fields for the general role; the seam is placed but the filtering is a no-op in step ②.

## Language

- **Task**: one worksheet row (summary parent or leaf subtask) carrying stored inputs only; derived columns live in the projection, not in the mutation state.
- **Member**: a project-scoped assignee with a working calendar and daily capacity.
- **Plan change**: any Current mutation other than an agent-scoped progress or actual-effort write on a single task.
- **Project query**: a read-only project operation authorized by tenant/project membership rather than a mutation role or agent write scopes.
- **WBS-grid projection**: the flat read model of 23 columns plus derived effort columns and the project rollup.
