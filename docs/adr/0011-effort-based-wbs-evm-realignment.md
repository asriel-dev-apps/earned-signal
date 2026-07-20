# ADR 0011: Effort-based WBS/EVM realignment to spreadsheet parity

## Status

Accepted (2026-07-20). Amends 0006, extends 0004, defers 0009 to Phase 2.

## Context

The delivered application was built money-first around a card dashboard. The team's
actual practice is an effort-based (person-day / person-hour) WBS/EVM spreadsheet: a dense
grid of roughly 23 typed columns plus a time-phased daily planned-value matrix (one column
per calendar day), with project- and change-level earned-value rollups. The delivered UI
diverged materially from that practice in unit (money vs effort), column set (≈8 vs ≈23),
and shape (cards vs dense grid).

The technology stack (Cloudflare Workers, Hono, React, PostgreSQL/Drizzle, MCP) is retained.
The data grid library is not part of that commitment and may change.

The reference spreadsheet contains confidential client data and is kept out of this
repository and never pushed. The exact column list, extracted formulas, and anonymized
verification fixtures are maintained in private, out-of-repository realignment docs
(requirements + column/formula map). This ADR and all repository code contain no client data.

## Decision

1. **Effort is the unit of record for earned value.** Values are person-hours; person-days =
   hours / 8. BAC/PV/EV/AC/SV/CV/SPI/CPI are computed in effort. No rounding is applied;
   division by zero yields `"-"` (planned-progress ratio yields `0`), per the private formula
   map. Money becomes a derived, optional cost layer (rate × effort) and is deferred to Phase 2.

2. **Reproduce the reference spreadsheet's ~23 columns 1:1** in a dense, virtualized grid:
   inline editing, clipboard copy/paste, keyboard navigation, phase/status coloring, and frozen
   header and left columns. Input columns are the effort estimate, the daily plot, actual
   progress, and actual effort; the remaining columns are computed per the private map.

3. **Time-phased daily planned-value matrix is rendered inside the grid** (one column per
   calendar day). Planned value is auto-placed by the scheduler. Daily cells default to
   auto-placed (display); a per-task manual-lock flag excludes a task from the scheduler for
   explicit hand editing, keeping "planned effort = sum of daily cells" consistent.

4. **Deterministic, capacity-aware scheduler for MVP.** It honors FS/SS/FF/SF relationships
   with working-day lag (extending ADR 0004), per-resource daily capacity, shared holidays,
   and individual non-working days, placing effort greedily in dependency-topological order.
   The constraint-based (CP-SAT) optimizer of ADR 0009 is retargeted to Phase 2 re-scheduling
   and leveling (e.g. "add one resource, minimize finish shift") and is not used for MVP placement.

5. **Subtask templates** define percent-weight proration of the parent's effort plus
   inter-subtask dependency/lag constraints (e.g. a review activity placed the next working
   day after its design activity). Generating from a template creates the subtasks, their
   proration, and their dependencies; parent-effort changes re-prorate. Dependencies, lag, and
   weights are editable per task. Tasks can be drag-re-parented.

6. **Hierarchy is a hybrid flat/tree toggle with drag re-parenting**, implemented on a headless
   virtualized grid (TanStack Table + TanStack Virtual) rather than AG Grid Enterprise Tree
   Data. AG Grid Community is dropped. A grid feasibility spike (≈23 fixed columns + ≈60–90
   daily columns + a few thousand rows + frozen columns + expand/collapse + drag) precedes
   implementation.

7. **Two roles: admin and general.** Sensitive fields (per-resource productivity/capacity and
   rate) are projected out of the general read model at the API boundary, not merely hidden in
   the UI.

8. **MVP is Current-only.** Baseline freezing and scenarios (ADR 0007/0008) move to Phase 2.
   Actual effort is entered directly on task rows. Change-level (backlog) rollups group by the
   task name and are Phase 2. Verification uses anonymized fixtures; the real spreadsheet is
   never imported into the application or the repository.

## Consequences

- **EVM domain** (0006) moves from money to effort as the unit of record; money EVM becomes a
  Phase-2 derived layer. Domain types, DB columns, API contracts, and golden tests are
  re-expressed in effort units, with new golden tests fixed from the private formula map.
- **Scheduling** (0004) gains capacity-aware placement; the existing relationship/lag/calendar
  engine is reused rather than rewritten. **Staffing optimization** (0009) is deferred to
  Phase 2 re-scheduling. **MCP** (0003) and **Monte Carlo forecasting** (0010) are retained for
  Phase 3.
- **Web workspace** is rebuilt on a headless grid; the card dashboard and AG Grid Community are
  removed. Grid capability is validated by a spike before broader work.
- **Phasing.** Phase 2: change-level rollups, cost layer, timesheet import, re-scheduling,
  baseline/scenario, EVM trend charts. Phase 3: MCP agent operations, Monte Carlo forecasts.
- **Confidentiality.** The reference spreadsheet and any real-data extracts remain out of the
  repository and are never pushed; anonymized fixtures are used for development and verification.
- **Implementation order.** Grid spike → schema/DB/CRUD + virtualized flat grid + fixtures →
  effort EVM core + golden tests → deterministic scheduler + daily matrix → subtask templates →
  tree/drag → field-level role projection. Each step carries an observable acceptance check.
