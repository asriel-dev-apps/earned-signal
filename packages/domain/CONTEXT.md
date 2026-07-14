# Domain context

The Domain context contains deterministic, infrastructure-free scheduling and earned value calculations.

Scheduling currently supports Monday-to-Friday calendars, finish-to-start dependencies, non-negative working-day lag, forward/backward passes, float, critical-path flags, and exact cycle membership.

EVM currently supports 0/100 and physical-percent measurement, status-date filtering, direct actual costs and labor worklog costs, and BAC/PV/EV/AC/SV/CV/SPI/CPI/EAC/ETC/VAC/TCPI. Effort is stored as integer minutes, currency values remain unrounded until final output, and zero denominators return `null`.
