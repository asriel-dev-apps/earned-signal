# Domain context

The Domain context contains deterministic, infrastructure-free scheduling and earned value calculations.

Scheduling supports project and activity working calendars, holidays, multiple FS/SS/FF/SF dependencies, bounded non-negative working-day lag, SNET/FNLT/MSO/MFO date constraints, forward/backward passes, float, critical-path flags, constraint-violation signals, and exact cycle membership. Activity duration follows its activity calendar. Relationship lag follows the project default calendar so one dependency has one stable lag basis even when the linked activities use different calendars.

EVM currently supports 0/100 and physical-percent measurement, status-date filtering, direct actual costs and labor worklog costs, and BAC/PV/EV/AC/SV/CV/SPI/CPI/EAC/ETC/VAC/TCPI. Effort is stored as integer minutes, currency values remain unrounded until final output, and zero denominators return `null`.

EVM history replays the latest Progress Measurement available at each weekly Period Bucket, filters Actual Cost by that bucket's status date, and produces an EVM Snapshot plus leaf-WBS variance ranking. The first and last buckets may be partial weeks; every intermediate bucket ends on Sunday.

Capacity analysis combines scheduled activity dates with each Resource's Calendar and Assignment units. It reports daily available and demanded minutes, over-allocation, utilization, planned labor cost, and required-Skill gaps without changing the schedule.

## Language

- **Resource**: a person or capacity unit that may be assigned to work packages.
- **Skill**: a named capability held by a Resource or required by a work package.
- **Assignment**: a planned fractional commitment of one Resource to one work package.
- **Units percent**: the percentage of a Resource's available daily minutes consumed by an Assignment, from 1 through 100.
- **Daily capacity**: the minutes a Resource can supply on a working day in its Calendar.
- **Over-allocation**: demand above a Resource's daily capacity. It remains visible and does not invalidate the plan.
- **Rate**: planned labor cost per productive hour, stored in minor currency units.
- **Period Bucket**: a weekly reporting interval with its own inclusive status date.
- **EVM Snapshot**: the calculated EVM metrics and ranked WBS variances as of one Period Bucket's status date.
