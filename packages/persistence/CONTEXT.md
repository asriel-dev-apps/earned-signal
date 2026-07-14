# Persistence context

The Persistence context maps PostgreSQL records to the Application and Domain contexts. PostgreSQL is the system of record; Drizzle schema and reviewed migration SQL are versioned together.

Tenant and project boundaries are enforced by composite foreign keys as well as Repository query predicates. Currency is stored as bigint minor units, effort as integer minutes, work dates as PostgreSQL `date`, and audit timestamps as `timestamptz` strings.

Baseline snapshots contain the full WBS hierarchy, activities, and dependencies. Snapshot rows can be inserted only while their version is a draft; approval seals the version and database triggers reject every later insert, update, or delete. Audit events are append-only. Migrations run from release tooling over a direct PostgreSQL connection, never during a Worker request or through Hyperdrive.

PostgresProjectCommandUnitOfWork locks the tenant-scoped Project row and commits the validated Current mutation, revision, AuditEvent, and command receipt atomically. Command receipts are append-only and keyed by tenant/project/idempotency key; a canonical SHA-256 request hash prevents the same key from representing different commands. Concurrent retries serialize on the Project lock and replay one result.
