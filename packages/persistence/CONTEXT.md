# Persistence context

The Persistence context maps PostgreSQL records to the Application and Domain contexts. PostgreSQL is the system of record; Drizzle schema and reviewed migration SQL are versioned together.

Tenant and project boundaries are enforced by composite foreign keys as well as Repository query predicates. Currency is stored as bigint minor units, effort as integer minutes, work dates as PostgreSQL `date`, and audit timestamps as `timestamptz` strings.

Skills, Resources, Resource Skills, work-package Skill requirements, and Assignments are tenant/project-scoped records. Composite foreign keys prevent an Assignment or Skill link from crossing its project boundary. Assignment units and Resource capacity/rates are constrained in PostgreSQL as well as the Application context.

OIDC principals are keyed by issuer/subject independently of any tenant. Tenant memberships and explicit project memberships bind a human or agent principal to authorization roles. Agent scopes are an allowlist stored with the principal; effective permission is the intersection of the stored allowlist and signed token scopes. Disabled or cross-tenant principals do not resolve to an access grant.

Baseline snapshots contain calendars, Skills, Resources and their Skill links, the full WBS hierarchy, activities with calendar/constraint and Skill requirements, Assignments, and typed dependencies. Snapshot rows can be inserted only while their version is a draft; approval seals the version and database triggers reject every later insert, update, or delete. Audit events are append-only. Migrations run from release tooling over a direct PostgreSQL connection, never during a Worker request or through Hyperdrive.

Period Buckets, EVM Snapshots, and ranked snapshot WBS variances are tenant/project scoped derived records tied to an approved Baseline Version. ProjectPerformanceRepository keeps queries read-only by calculating from PostgreSQL source records; successful project commands refresh the derived cache under a project-row lock so concurrent refreshes cannot interleave.

PostgresProjectCommandUnitOfWork locks the tenant-scoped Project row and commits the validated Current mutation, revision, AuditEvent, and command receipt atomically. Command receipts are append-only and keyed by tenant/project/idempotency key; a canonical SHA-256 request hash prevents the same key from representing different commands. Concurrent retries serialize on the Project lock and replay one result.

Scenarios are tenant/project-scoped plan-change branches pinned to a base Project revision. Draft edits increment only the Scenario revision and invalidate its latest Run; Scenario Runs and Scenario Audit Events are append-only. Published and discarded Scenarios are terminal. Scenario calculation and lifecycle operations never mutate Current or its Project revision; publishing into Current is a separate atomic Application use case.

Staffing Proposals are tenant/project-scoped, idempotent optimization requests pinned to a base Project revision. Their immutable JSON input contains the Current snapshot, human-confirmed effort, candidate Resources, constraint and objective contract versions, and fixed objective order. State transitions are one-way from requested through running to the first terminal result. A solved Proposal Run retains the Application result, including verified metrics and changes when feasible, diagnostics, explanation when feasible, and solver metadata; a host-failure Run instead records a stable failure code and message. Proposal Runs and Proposal Audit Events are append-only.

READY completion uses one PostgreSQL transaction that locks the Project and Proposal, confirms the base Project revision is still current, appends the READY Proposal Run, creates the DRAFT Scenario with the exact verified changes, links it, and appends Proposal audit events. A generic terminal write is forbidden from producing READY, so a visible READY Proposal always has a linked Scenario. The Workflow persists the Scenario's deterministic calculation Run in a later retryable step; that later Run is not part of the READY-link transaction. Current and Baseline remain unchanged until the Scenario is published through the normal human approval boundary.

## Language

- **Current resource plan**: the mutable Resources, Skills, and Assignments attached to the Current project state.
- **Baseline resource plan**: the immutable Skills, Resources, Skill links, Skill requirements, and Assignments captured when a Baseline Version is approved.
- **Resource Skill**: a project-scoped link between a Resource and a Skill.
- **Work-package Skill requirement**: a project-scoped link declaring that a work package requires a Skill.
- **Stored performance**: a reproducible derived cache of Period Buckets and EVM Snapshots; progress, worklogs, costs, and the approved Baseline remain authoritative.
- **Scenario**: a versioned, isolated set of prospective plan changes based on one Project revision.
- **Scenario Run**: an immutable calculation result tied to exact Project and Scenario revisions, input, algorithm version, and input hash.
- **Staffing Proposal Run**: the immutable terminal result of one Proposal, including its algorithm version and JSON output. READY is valid only with a Scenario created and linked in the same transaction.
