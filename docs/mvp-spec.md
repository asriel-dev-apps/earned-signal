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

- A calendar-aware scheduling module with multiple FS/SS/FF/SF dependencies, bounded non-negative working-day lag, project and activity calendars, holidays, date constraints, forward and backward passes, total float, critical-path flags, constraint-violation signals, and cycle detection.
- A pure earned value module producing BAC, PV, EV, AC, SV, CV, SPI, CPI, EAC, ETC, VAC, and TCPI. Ratios with a zero denominator are `null`.
- Weekly Period Buckets and replayable EVM Snapshots using the latest measurement and actuals available at each status date, including ranked leaf-WBS schedule/cost variances.
- A React shell and Hono `/api/health` route built together by the Cloudflare Vite plugin.
- An editable AG Grid Community workspace for hierarchical leaf work packages, typed dependencies, calendars, and constraints, with immediate schedule and single-status-date EVM recalculation. Baseline dates remain frozen while Current inputs change.
- Add and delete commands plus typed cell updates through the shared application command boundary.
- Project Skills, Resources, calendar-based daily capacity, hourly planned rates, required Skills, and percentage Assignments, with overload and Skill-gap analysis.
- An editable task Assignment surface and Current/Baseline Team workload view with utilization, daily demand, over-allocation, Skill gaps, and planned labor cost. Baseline publishing freezes Resource, Skill, rate, requirement, and Assignment snapshots.
- A PostgreSQL system of record with reviewed Drizzle migrations, tenant/project boundary constraints, schedule calendars and constraints, exact minor-unit money, integer-minute effort, immutable approved baseline snapshots, immutable audit events, and a tenant-scoped Repository.
- A deterministic demo seed that round-trips current WBS, activities, dependencies, measurements, worklogs, direct actual costs, and the full approved baseline through real PostgreSQL.
- A shared Project Command Service with an atomic PostgreSQL unit of work, optimistic revision checks, canonical idempotency receipts, and append-only audit events.
- A Zod-validated Hono REST command route with generated OpenAPI 3.1, stable validation/conflict responses, bounded request bodies, decimal-string revisions and minor-unit money, and a fail-closed authentication seam.
- An authenticated no-store Project workspace query and browser client for persisted Current/Baseline loading, explicit save state, revision conflicts, actual entry, and immutable Baseline publishing; unconnected preview data is never represented as saved.
- An authenticated no-store Performance API and workspace with PV/EV/AC trend lines, SPI/CPI/EAC/TCPI indicators, and largest WBS variances.
- An OIDC resource-server adapter that verifies asymmetric bearer JWTs and maps issuer/subject to PostgreSQL principals, tenant/project memberships, project roles, agent scopes, and stable internal audit actors.
- Human owners/editors may change Current. Agent service identities may directly record only scoped progress/actuals; agent plan changes are rejected until a human-approved proposal flow exists.
- A stateless Streamable HTTP MCP endpoint with OAuth protected-resource metadata, a resource-specific token audience, focused task, Resource, and Assignment tools, and the same authorization, validation, idempotency, transaction, and audit boundary as REST.
- Node.js 24 LTS and pnpm for development and CI.

## Explicitly out of scope

- Billing, self-service signup/invitation UI, and production identity-provider tenant/client provisioning.
- Production PostgreSQL provisioning and Hyperdrive bindings.
- Enterprise-only WBS Tree Data, Gantt product integration, range clipboard, and other Enterprise-only grid features. Hierarchy is edited through typed Community-grid columns.
- Automatic resource leveling and capacity optimization. Capacity and over-allocation are analyzed without automatically changing the schedule.
- Monte Carlo simulation, optimization, and AI estimates.
- EIA-748 compliance.

Production deployments connect the Worker to PostgreSQL through Hyperdrive. The deployed identity provider remains responsible for OAuth authorization-server metadata, client registration policy, and issuing tokens whose audience is the canonical MCP resource URL.
