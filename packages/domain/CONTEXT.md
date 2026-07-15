# Domain context

The Domain context contains deterministic, infrastructure-free scheduling and earned value calculations.

Scheduling supports project and activity working calendars, holidays, multiple FS/SS/FF/SF dependencies, bounded non-negative working-day lag, SNET/FNLT/MSO/MFO date constraints, forward/backward passes, float, critical-path flags, constraint-violation signals, and exact cycle membership. Activity duration follows its activity calendar. Relationship lag follows the project default calendar so one dependency has one stable lag basis even when the linked activities use different calendars.

EVM currently supports 0/100 and physical-percent measurement, status-date filtering, direct actual costs and labor worklog costs, and BAC/PV/EV/AC/SV/CV/SPI/CPI/EAC/ETC/VAC/TCPI. Effort is stored as integer minutes, currency values remain unrounded until final output, and zero denominators return `null`.
