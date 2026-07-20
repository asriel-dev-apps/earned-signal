# Domain context

The Domain context contains deterministic, infrastructure-free scheduling and earned-value calculations.

Scheduling supports project and activity working calendars, holidays, multiple FS/SS/FF/SF dependencies, bounded non-negative working-day lag, SNET/FNLT/MSO/MFO date constraints, forward/backward passes, float, critical-path flags, constraint-violation signals, and exact cycle membership. Activity duration follows its activity calendar. Relationship lag follows the project default calendar so one dependency has one stable lag basis even when the linked activities use different calendars. Scheduling is a pure engine retained for the ④ capacity-aware placement step.

Effort EVM is the earned-value engine. Task effort is person-hours stored as integer person-minutes; project aggregates are person-days = person-hours / 8. Per task it derives K (planned person-days = L/8), M (planned person-hours = Σ daily plot), N (planned earned to the status date), O (planned progress = N/M, div0 → 0), P/Q (first/last non-zero daily date), U (status from T), V (earned effort = M × T), and X (cost variance = V − W). The project rollup sums M/8, N/8, (M × T)/8, and W/8 into BAC/PV/EV/AC, then derives SV, CV, SPI = EV/PV, and CPI = EV/AC. There is no rounding; a zero denominator yields `"-"` while the planned-progress ratio yields `0`. This module is the single formula source for both the server projection and the client's optimistic recompute.

Capacity analysis combines scheduled dates with each member's calendar and daily capacity to report daily available and demanded minutes, over-allocation, and utilization. It is a pure engine retained for ④; money-derived outputs (rate × effort) are a Phase 2 concern.

## Language

- **Person-day / person-hour / person-minute**: the effort units; a person-day is 8 person-hours, and effort is stored as integer person-minutes.
- **Planned effort (L)**: a task's whole-minute planned estimate; K = L/8 person-days.
- **Daily planned-value plot**: a sparse `ISO-date → minutes` map whose sum is the planned effort M and whose non-zero extent gives the planned start P and finish Q.
- **Progress (T)**: an actual completion fraction stored as basis points (0–10000); earned effort V = M × T.
- **Status (U)**: not-started, in-progress, or done, derived from T.
- **Rollup**: BAC/PV/EV/AC in person-days with SV, CV, SPI, and CPI derived from them.
