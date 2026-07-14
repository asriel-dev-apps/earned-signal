# EarnedSignal thin MVP specification

## Purpose

EarnedSignal provides one consistent place to maintain a WBS, an approved baseline, current progress, actual effort, and earned value forecasts. The product is public from the outset and may become a commercial service.

## Confirmed product rules

- Baseline, current plan, and scenario are distinct states. A scenario never mutates the current plan until explicitly published.
- The spreadsheet is a typed editing surface, not the persistence model.
- All Web, REST, and MCP mutations eventually pass through the same application command boundary.
- Agent-initiated plan changes require human approval. Progress and worklog permissions will be scoped and audited.
- Initial earned value methods are 0/100 and physical percent complete.
- The initial estimate-at-completion formula is `BAC / CPI`.
- PV is spread evenly across Monday-to-Friday baseline working days and is accumulated through the inclusive status date.
- Currency outputs are rounded to two decimal places and ratios to four decimal places. Intermediate values remain unrounded; division by zero produces `null`.
- Effort is stored in minutes, currency is JPY, periods are weekly, and the display time zone is Asia/Tokyo.

## This technical slice

- A Monday-to-Friday scheduling module with finish-to-start dependencies, non-negative working-day lag, forward and backward passes, total float, critical-path flags, and cycle detection.
- A pure earned value module producing BAC, PV, EV, AC, SV, CV, SPI, CPI, EAC, ETC, VAC, and TCPI. Ratios with a zero denominator are `null`.
- A React shell and Hono `/api/health` route built together by the Cloudflare Vite plugin.
- An editable AG Grid Community workspace for leaf work packages, with immediate schedule and single-status-date EVM recalculation. Baseline dates remain frozen while Current inputs change.
- Add and delete commands plus typed cell updates through the shared application command boundary.
- A PostgreSQL system of record with reviewed Drizzle migrations, tenant/project boundary constraints, exact minor-unit money, integer-minute effort, immutable approved baseline snapshots, immutable audit events, and a tenant-scoped Repository.
- A deterministic demo seed that round-trips current WBS, activities, dependencies, measurements, worklogs, direct actual costs, and the full approved baseline through real PostgreSQL.
- Node.js 24 LTS and pnpm for development and CI.

## Explicitly out of scope

- Authentication, authorization, billing, and production audit command wiring.
- Production PostgreSQL provisioning and Hyperdrive bindings.
- Hierarchical WBS Tree Data, Gantt product integration, range clipboard, and other Enterprise-only grid features.
- Resource calendars beyond Monday to Friday, holidays, constraints, resource leveling, and non-FS dependency types.
- REST command API, MCP server, and server-side command transport.
- Monte Carlo simulation, optimization, and AI estimates.
- EIA-748 compliance.

Production Worker persistence will connect to PostgreSQL through Hyperdrive. Future remote MCP support will use a stateless `createMcpHandler` under `agents/mcp`.
