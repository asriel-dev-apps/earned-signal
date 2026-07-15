# ADR 0005: Resource capacity semantics

## Status

Accepted

## Context

Resource demand must be deterministic across the browser, command validation, PostgreSQL round-trips, and later optimization. A task owner alone is not sufficient: accountability, working time, capability, and fractional commitment are separate facts.

## Decision

- A Resource has a working Calendar, available minutes per working day, a planned hourly Rate, and zero or more Skills.
- An Assignment connects one Resource to one work package with integer `unitsPercent` from 1 through 100. Replacing a task's Assignments is atomic.
- On each Resource working day within a task's inclusive scheduled dates, demand equals the Resource's daily capacity multiplied by Assignment units. Multiple Assignments add together.
- Over-allocation is reported when daily demand exceeds capacity; it does not reject the plan or move scheduled dates.
- A required Skill is covered when at least one assigned Resource holds it. Missing coverage is reported as a Skill gap.
- The work-package owner remains an accountability label and never implies an Assignment.

## Consequences

Capacity analysis is a pure projection over scheduled dates and the resource plan, so UI, API, MCP, and later optimizers share one numeric contract. Resource calendars and percentage units make part-time and concurrent commitments explicit. Automatic leveling remains separate because silently moving work would change an approved plan.
