# ADR 0004: Production scheduling semantics

## Status

Accepted

## Context

A practical WBS needs more than a single finish-to-start predecessor and a fixed Monday-to-Friday week. Work packages may have several predecessors, different relationship semantics, holidays or team workweeks, and externally imposed dates. These inputs must produce the same deterministic result in the browser, REST/MCP command validation, and PostgreSQL round-trips.

## Decision

- A work package may have multiple FS, SS, FF, or SF dependencies. Lag is a non-negative integer capped at 10,000 working days.
- Activity duration follows the activity's assigned calendar. Dependency lag follows the project default calendar, giving a relationship one stable basis when linked activities use different calendars.
- Calendars define ISO working weekdays and explicit non-working ISO dates. Every project and approved baseline stores its calendars, including a default calendar.
- Constraints are SNET, FNLT, MSO, or MFO with one ISO date. Dependency logic remains authoritative: when a hard date cannot be met, the schedule reports a violation instead of hiding the conflict.
- WBS summary groups remain separate from leaf activities. The Community grid edits a leaf's WBS code and parent explicitly; Enterprise Tree Data is not required.
- Resource capacity and leveling are separate concerns and are not inferred from calendars.

## Consequences

The scheduler stays deterministic and infrastructure-free. PostgreSQL foreign keys reject unknown calendar assignments, and approved baseline calendar rows are immutable with the rest of the snapshot. Mixed-calendar schedules are explainable because duration and lag bases are explicit. Impossible constraints remain visible to users and later optimization work can consume the violation signal.
