# ADR 0006: EVM history semantics

## Status

Accepted

## Context

A single current EVM result cannot explain trend or reproduce what was knowable at an earlier status date. Historical reporting must not apply later progress or actual costs retroactively, and stored snapshots must remain traceable to an approved baseline.

## Decision

- Reporting uses weekly Period Buckets ending Sunday. The first bucket starts at Project start and the last bucket ends on its normal Sunday while using the current status date as its partial cutoff.
- Each EVM Snapshot selects the latest Progress Measurement at or before its status date and includes only Worklogs and Direct Actual Costs dated through that day.
- Every snapshot uses the approved Baseline's dates, measurement method, and budget. Leaf-work-package schedule and cost variances are ranked by the combined absolute variance magnitude.
- PostgreSQL stores calculated snapshots as a derived cache tied to its Baseline Version. The source Baseline, measurements, Worklogs, and costs remain authoritative; API reads calculate without mutation, while successful project commands refresh the cache under a project-row lock.
- Project reads require an explicit tenant/project grant. Viewer access is sufficient; mutation roles and agent write scopes do not govern read-only performance queries.

## Consequences

Trend values are reproducible and do not leak future measurements into earlier periods. Partial current weeks are visible without inventing a later status date. Recalculation can safely replace derived rows, while approved Baseline immutability preserves the reference plan.
