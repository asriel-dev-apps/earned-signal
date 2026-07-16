# ADR 0008: Deterministic Scenario forecasting and publication

## Status

Accepted for the beta Scenario workflow.

## Context

A Scenario must answer two different questions without changing Current: where the project lands if its measured trend continues, and how explicit plan changes alter that landing. A result also needs to remain explainable after Current has changed.

## Decision

- Scenario is a separate, project-scoped aggregate. It records an ordered set of existing plan-only project commands. Progress, actuals, and Baseline publication are not valid Scenario changes.
- A Scenario is based on one Current project revision. Editing increments the Scenario revision but never the project revision. A draft becomes terminal when discarded or published.
- A run stores its complete Current, Baseline, and Scenario input, Scenario and project revisions, algorithm version, canonical input hash, output, actor, and timestamp. Runs are immutable.
- Algorithm `deterministic-trend-v1` first applies the Scenario changes with the normal Application validation. It then calculates SPI and CPI from Current against the approved Baseline.
- A missing, non-finite, zero, or negative SPI/CPI uses a neutral factor of `1` and is identified as a fallback in the result.
- For each unfinished work package, the forecast duration is `ceil(completedEquivalentDays + remainingPlanDays / SPI)`, bounded by the supported activity-duration range. Completed work packages retain the Scenario plan duration. New work packages have zero completed days.
- Forecast EAC is the sum of actual cost plus remaining Scenario budget divided by CPI. Planned Resource labor cost, overload resource-days, Skill gaps, finish date, and per-task finish dates are reported separately rather than being hidden inside EAC.
- Publish means Scenario to Current. It does not publish or modify Baseline. The latest run must match both the current Scenario revision and the locked project revision. Stale drafts fail closed and are never automatically rebased.
- Publish applies every Scenario change, validates and saves Current, increments the project revision once, writes project and Scenario audit records, records the idempotent receipt, and marks the Scenario published in one PostgreSQL transaction.
- Human owners and editors approve by using the publish confirmation. This beta does not introduce a separate request/approver state machine. Agent publication remains forbidden.

## Consequences

The same stored input and algorithm version produces the same output and hash. Users can distinguish EVM cost trend from Resource plan cost. A Scenario must be cloned or recreated after Current changes, which avoids silently changing the meaning of an approved proposal.
