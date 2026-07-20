# VECTA thin MVP specification

## Purpose

VECTA provides one consistent place to maintain a WBS, an approved baseline, current progress, actual effort, and earned value forecasts. The product is public from the outset and may become a commercial service.

## Confirmed product rules

- Baseline, current plan, and scenario are distinct states. A scenario never mutates the current plan until explicitly published.
- The spreadsheet is a typed editing surface, not the persistence model.
- Current project mutations from Web, REST, and MCP pass through `ProjectCommandService`; Staffing Proposal requests instead share their `StaffingProposalAuthorizer`, validation, Repository, and Workflow dispatch boundary and do not mutate Current.
- Agent-initiated plan changes require human approval. An Agent project owner/editor with `project:staffing:propose` in both its stored grant and signed token may request a Staffing Proposal, but cannot mutate or publish its linked Scenario. Direct progress and worklog permissions remain separately scoped and audited.
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
- A revision-pinned Scenario workspace for typed plan changes, reproducible deterministic trend runs, Current/cost/capacity comparison, discard, and stale-safe human publication into Current without changing Baseline.
- Revision-pinned, idempotent Staffing Proposals requested through the authenticated Web, REST, or MCP surfaces. Every unfinished Task requires positive whole-minute remaining effort and a maximum parallel-Resource count explicitly confirmed by a human.
- A fixed staffing objective order of earliest finish, least total overtime, lowest planned labor cost, and fewest changed Task/Resource Assignment pairs. Hard bounds cover deadline, planned labor cost, total overtime, Assignment-pair changes, Task schedule changes, candidate Resource use, and required-Skill coverage. Application acceptance recomputes cost and overtime over the complete proposed Project plan rather than trusting the solver's unfinished-Task totals.
- An asynchronous Cloudflare Workflow that calls a private Container running a pinned Python/OR-Tools CP-SAT service. The solver uses integer variables, a fixed seed, one search worker, and fixed wall-clock and deterministic limits per lexicographic stage; `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN`, and model/host failures remain distinguishable in persisted results.
- Application-side revalidation of every solver response. The Application layer checks the source revision and solver metadata, converts only supported Resource, Assignment, duration, and start-date changes, reapplies the normal Project invariants, and independently recomputes the schedule, confirmed-effort coverage, capacity, total overtime, labor cost, Assignment-pair and schedule changes, candidate count, and Skill coverage.
- Atomic persistence of a READY Proposal Run and its linked DRAFT Scenario at the same still-current Project revision. Creating the deterministic Scenario Run is a subsequent retryable Workflow step; only the existing human-only Scenario publication command can mutate Current, and it never mutates Baseline.
- A Staffing Proposal workspace that displays persisted lifecycle state, verified numeric facts, exact Scenario commands, sufficient-but-not-necessarily-minimal infeasibility diagnostics, and the linked Scenario review action. Workers AI produces bounded prose from verified facts only; invalid or unavailable AI output falls back to deterministic prose.
- Revision-pinned and idempotent Monte Carlo Forecast Runs with human-confirmed three-point estimates, triangular and correlated sampling, a stored uint32 seed, canonical input hash, convergence checkpoints, P50/P80 dates and costs, target-date probability, and histograms. The Application layer independently verifies source revisions, input identity, stopping evidence, quantiles, probability, and cost summaries before accepting a READY result.
- A Cloudflare Queue and DLQ boundary for forecast execution with per-message acknowledgement, bounded retry, first-terminal-result persistence, and a private network-disabled Forecast Simulator Container. Environment-specific Queue names are checked by the consumer rather than hardcoded.
- Separate staging and production Worker, Hyperdrive, Workflow, Queue, DLQ, Container, observability, and rate-limit configuration; a staging-first manual deployment workflow; target-confirmed advisory-locked PostgreSQL migrations; bounded edge requests; structured metadata-only logs; security headers; and reviewed operations/security runbooks.
- An authenticated no-store Performance API and workspace with PV/EV/AC trend lines, SPI/CPI/EAC/TCPI indicators, and largest WBS variances.
- An OIDC resource-server adapter that verifies asymmetric bearer JWTs and maps issuer/subject to PostgreSQL principals, tenant/project memberships, project roles, agent scopes, and stable internal audit actors.
- Human owners/editors may change Current. Agent service identities may directly record only scoped progress/actuals; an Agent project owner/editor with `project:staffing:propose` in both its stored grant and signed token may request a Proposal but cannot mutate or publish its linked Scenario.
- A stateless Streamable HTTP MCP endpoint with OAuth protected-resource metadata, a resource-specific token audience, focused task, Resource, Assignment, and Staffing Proposal tools. REST and MCP share staffing request validation, authorization, idempotency hashing, PostgreSQL persistence, Workflow dispatch, and read models; neither adapter accepts a solver result or publishes a Scenario.
- Node.js 24 LTS and pnpm for development and CI.

## Explicitly out of scope

- Billing, self-service signup/invitation UI, and production identity-provider tenant/client provisioning.
- Production PostgreSQL provisioning and Hyperdrive bindings.
- Enterprise-only WBS Tree Data, Gantt product integration, range clipboard, and other Enterprise-only grid features. Hierarchy is edited through typed Community-grid columns.
- Automatic publication of optimized plans. Staffing optimization creates a draft Scenario and requires explicit human review and publication.
- Daily or preemptive Assignments, overtime premiums, hiring lead time, Skill-specific effort allocation, and probabilistic productivity in the staffing model.
- Provider account creation, production PostgreSQL and OIDC provisioning, approval of retention/backup/alert thresholds, and collection of live public-URL end-to-end evidence. These are go-live operations performed with the committed deployment workflow and runbooks, not values stored in the public repository.
- EIA-748 compliance.

The intended production topology connects the Web, optimizer, and simulator Workers to PostgreSQL through Hyperdrive, runs CP-SAT in a private Cloudflare Container coordinated by a Workflow, and runs Monte Carlo simulation in a private Container coordinated by Queue and DLQ consumers. Real resources are materialized at deploy time rather than committed. A deployed identity provider remains responsible for OAuth authorization-server metadata, client registration policy, and issuing tokens whose audience is the canonical MCP resource URL.
