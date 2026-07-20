# Design 0002: Effort-first WBS/EVM core — optimal data model, excision plan, and rebuild slice

Status: Draft for advisor review. Supersedes the earlier additive/backward-non-breaking draft.
Scope owner: design-only; no code is changed by this document.

## 0. What changed since the previous draft (read this first)

The previous version of this document designed step ② as an **additive, backward-non-breaking**
extension of the delivered money-first model: it kept `wbs_nodes` + `activities`, kept the money
columns and the baseline/scenario/staffing/forecast subsystems live, and rejected a self-referential
`tasks` table specifically to avoid a non-additive rewrite (former §4.1, §4.2, §5, §9).

**That constraint is withdrawn.** The user has decided:

1. **No backward compatibility.** There is no production data to preserve. We model the domain
   optimally and reshape the database freely.
2. **Excise the deferred subsystems from the MVP build.** Baseline, scenarios, the CP-SAT staffing
   optimizer, the Monte-Carlo forecast simulator, and MCP are **removed from the MVP build and
   preserved in git history**, to be rebuilt on the new model in later phases (Phase 2/3). The MVP
   build is exactly `apps/web` + `packages/{domain,application,persistence}`.
3. **Money is not in the core.** Effort is the unit of record. Money re-enters in Phase 2 as a
   derived layer (`rate × effort`), per ADR 0011 §Decision 1.

This document is therefore rewritten around the **optimal model**: a single self-referential
`tasks` table carrying the worksheet's typed columns natively, a minimal scheduling-support schema,
a clean initial database, an effort-only EVM, and an explicit, verifiable **excision plan** that
keeps the remaining MVP green under `pnpm check`.

**Reused from the previous draft (unchanged):** the 23-column ⇔ formula mapping (§3 below; the
formulas are invariant), the TanStack virtualized-grid approach and its spike gotchas (§8), and the
rule that golden values are self-derived from the generic formulas on synthetic inputs — the private
worksheet is never read.

Unit conventions (ADR 0011 §Decision 1): task-level effort is **person-hours**, stored as integer
**person-minutes**; project EVM aggregates are **person-days = person-hours / 8**. No rounding.
Division by zero yields `"-"`; the planned-progress ratio yields `0`.

Confidentiality: only generic PM/EVM terminology appears here. No client, vendor, product, or
contract names, and no real values, in this document, in code, in fixtures, or in migrations. The
reference worksheet under `.wbs-private/` is never read and never imported.

## 1. Current model summary (as built — the thing we are replacing)

Evidence base (files read for this design):
`packages/persistence/src/schema.ts` (1,522 lines, 37 tables), `project-record.ts`,
`project-repository.ts`, `project-workspace.ts`, `project-command-unit-of-work.ts`,
`project-performance.ts`, `project-scenario.ts`, `project-staffing-proposal.ts`,
`project-forecast-run.ts`, `index.ts`; `packages/application/src/*`;
`packages/domain/src/{evm,scheduling,capacity}.ts`; `apps/web/src/{worker,api,mcp,App,
project-command-contract,project-api-client}.ts` and `wrangler.jsonc`; `spikes/tanstack-grid/
FINDINGS.md`; root `package.json`, `pnpm-workspace.yaml`, `.github/scripts/*`.

- **Two-level hierarchy.** `wbs_nodes` (self-referential group tree; `code`/`name`/`parent_id`,
  `schema.ts:270`) plus `activities` (leaf work packages, each with a required `wbs_node_id`,
  `schema.ts:312`). Dependencies, assignments, skills, progress, and worklogs are all keyed by
  `activity_id`. A subtlety the read model exploits: `project-workspace.ts:54` treats
  `wbs_nodes` **not referenced by any activity** as "groups", and each activity's own
  `wbs_node.parentId`/`code` become the task's `wbsParentId`/`wbs`. So the write path
  (`project-command-unit-of-work.ts:551-616`) actually maintains **one `wbs_node` per activity** —
  the group tree is vestigial glue.
- **Money-first effort.** `activities.budget_minor` (planned cost, `schema.ts:325`);
  `resources.cost_rate_minor_per_hour` (`schema.ts:196`); `worklogs` (dated `actual_minutes` +
  `rate_minor_per_hour`, effort entry writes `rate=0`, `schema.ts:995`); `direct_actual_costs`
  (`schema.ts:1026`); `progress_measurements` (dated basis-point progress, `schema.ts:960`);
  `period_buckets` + `evm_snapshots` + `evm_snapshot_wbs_variances` (money numeric EVM cache tied to
  an **approved baseline**, `schema.ts:869-958`).
- **Deferred subsystems (extensive).** Ten `baseline_*` mirror tables (`schema.ts:454-867`);
  `scenarios`/`scenario_runs`/`scenario_audit_events` (`schema.ts:1117-1235`);
  `staffing_proposals`/`staffing_proposal_runs`/`staffing_proposal_audit_events`
  (`schema.ts:1237-1376`); `forecast_runs`/`forecast_run_results`/`forecast_run_audit_events`
  (`schema.ts:1378-1482`).
- **Application.** `ProjectState`/`ProjectTask` (`project-state.ts:52-83`) already presents a flatter
  shape than persistence and already carries `actualMinutes` (effort). Its command union
  (`project-state.ts:161`) includes `baseline.publish`, `scenario.publish`, `assignment.replace`,
  `resource.*`. The write path reconstitutes the whole `ProjectState`, applies one command, and
  reconciles the entire project back into the normalized tables under a project-row lock, with
  idempotency receipts, optimistic concurrency (`expectedRevision`), audit events, and a
  monotonic-actuals guard (`project-command-unit-of-work.ts:95-875`).
- **Domain.** `scheduling.ts` (forward/backward pass, FS/SS/FF/SF + working-day lag + calendars +
  constraints, float, critical path, cycle detection; consumes `durationWorkingDays`) and
  `capacity.ts` (per-day demand from `dailyCapacityMinutes × unitsPercent`) are **pure and reusable**.
  `evm.ts` is **money** BAC/PV/EV/AC tied to a baseline (`evm.ts:196`, `project-performance.ts:25`).
  There is no per-day planned-value matrix and no effort EVM.
- **Web.** `App.tsx` is an **AG Grid Community** editable grid (`App.tsx:1-18`) with ~8 money columns.
  `mcp.ts` is a stateless MCP handler over `/mcp` (`agents/mcp` `createMcpHandler`, no Durable Object;
  `mcp.ts:7,495`). `worker.ts:44-107` wires the API app, the MCP handler, `STAFFING_WORKFLOW`, and
  `FORECAST_QUEUE`. `spikes/tanstack-grid/FINDINGS.md` returns **GO** for a headless TanStack grid at
  3000 rows × 113 columns with zero >50 ms long-tasks in a production build.

## 2. The 23 columns ⇔ optimal-schema correspondence (formulas invariant)

Worksheet columns A–X plus the daily plot, in generic form. "Input" = user-entered/stored; "Derived"
= computed by a pure function, never stored as authority. Storage target = the new `tasks` table
unless noted.

| Col | Meaning | Kind | Storage / source (optimal model) |
|-----|---------|------|-----------------------------------|
| A | No. (project prefix + sequence) | Derived | display from `sort_order` (+ project code); not stored |
| B | Process (工程) | Input | `tasks.process` text |
| C | Product (プロダクト) | Input | `tasks.product` text |
| D | Task name (EVM summary key) | Input | `tasks.name` (parent rows) |
| E | Review-management no. | Input | `tasks.review_ref` text |
| F | Subtask | Input | `tasks.name` (child rows via `parent_task_id`) |
| G | Change-management ref (Phase-2 rollup key) | Input | `tasks.change_ref` text |
| H | Note / URL | Input | `tasks.note` text |
| I | Contract | Input | `tasks.contract` text |
| J | Assignee (担当) | Input | `tasks.assignee_member_id` → `members.name` (see §4) |
| K | Effort (person-days) = L/8, div0→`"-"` | Derived | from L |
| **L** | **Effort (person-hours) = planned estimate** | **Input** | **`tasks.planned_effort_minutes` (int, person-minutes)** |
| M | Planned effort (person-hours) = Σ daily PV | Derived | from `daily_plan` |
| N | Planned earned to date (task PV) = Σ daily ≤ status date | Derived | from `daily_plan` + `projects.status_date` |
| O | Planned progress = N/M, div0→`0` | Derived | from M, N |
| P | Planned start = first non-zero daily | Derived | from `daily_plan` |
| Q | Planned finish = last non-zero daily | Derived | from `daily_plan` |
| R | Actual start | Input | `tasks.actual_start` date null |
| S | Actual finish | Input | `tasks.actual_finish` date null |
| **T** | **Progress (0–1) = actual** | **Input** | **`tasks.progress_basis_points` (int 0–10000), T = /10000** |
| U | Status = f(T): not-started / in-progress / done | Derived | from T |
| V | Actual earned effort (EV) = M×T | Derived | from M, T |
| **W** | **Actual expended effort (AC) = person-hours** | **Input** | **`tasks.actual_effort_minutes` (int, person-minutes)** |
| X | Cost variance (CV) = V−W | Derived | from V, W |
| Y… | Daily planned-value plot (1 col/day) | Input | `tasks.daily_plan` jsonb + `tasks.daily_plan_locked` bool |

Project-level rollup (person-days): `BAC = Σ(task M / 8)`, `PV`, `EV`, `AC` likewise; `SV = EV−PV`,
`CV = EV−AC`, `SPI = EV/PV` (div0→`"-"`), `CPI = EV/AC` (div0→`"-"`). Change-level rollup grouped by
G/D is Phase 2 — the `change_ref` column is present so the grouping is reachable later, but the
rollup is not built now.

## 3. The optimal `tasks` table (confirmed)

One self-referential table replaces `wbs_nodes` + `activities`. All effort is integer minutes;
progress is integer basis points (reusing the existing convention and the `ZERO_HUNDRED` check).

**Columns**

| Column | Type | Null/Default | Notes |
|--------|------|--------------|-------|
| `id` | uuid | PK, default random | identity |
| `tenant_id` | uuid | not null | project scope (per current convention) |
| `project_id` | uuid | not null | project scope |
| `parent_task_id` | uuid | **null** | self-FK; the grid tree axis (D→F) |
| `sort_order` | integer | not null default 0 | display order (col A) |
| `name` | text | not null | col D/F |
| `process` | text | not null default `''` | col B |
| `product` | text | not null default `''` | col C |
| `review_ref` | text | not null default `''` | col E |
| `change_ref` | text | not null default `''` | col G (Phase-2 rollup key) |
| `note` | text | not null default `''` | col H |
| `contract` | text | not null default `''` | col I |
| `assignee_member_id` | uuid | **null** | col J → `members` (see §4; advisor item A) |
| `planned_effort_minutes` | integer | not null default 0 | **L** (person-minutes) |
| `progress_basis_points` | integer | not null default 0 | **T** (0–10000); T = /10000 |
| `actual_effort_minutes` | integer | not null default 0 | **W** (person-minutes) |
| `measurement_method` | enum | not null default `PHYSICAL_PERCENT` | governs T's 0/100 vs percent rule |
| `daily_plan` | jsonb | not null default `'{}'` | sparse `ISO-date → minutes` map |
| `daily_plan_locked` | boolean | not null default false | excludes task from ④ auto-placement |
| `duration_working_days` | integer | not null | scheduling window (feeds `scheduling.ts`) |
| `calendar_id` | text | not null default `'standard'` | → `project_calendars` |
| `constraint_type` | enum | null | schedule constraint (reused) |
| `constraint_date` | date | null | schedule constraint (reused) |
| `actual_start` | date | null | **R** |
| `actual_finish` | date | null | **S** |
| `created_at` / `updated_at` | timestamptz | not null default now | audit |

**Constraints / indexes**

- `unique (tenant_id, project_id, id)` — required as the self-FK target (mirrors
  `activities_tenant_project_id_unique`, `schema.ts:332`).
- self-FK `(tenant_id, project_id, parent_task_id) → tasks(tenant_id, project_id, id)` `ON DELETE
  RESTRICT` (mirrors `wbs_nodes_parent_fk`, `schema.ts:300`).
- `check not_own_parent`: `parent_task_id is null or parent_task_id <> id` (mirrors
  `wbs_nodes_not_own_parent`, `schema.ts:308`).
- project FK `(tenant_id, project_id) → projects(tenant_id, id)` `ON DELETE cascade`.
- calendar FK `(tenant_id, project_id, calendar_id) → project_calendars` `ON DELETE restrict`.
- assignee FK `(tenant_id, project_id, assignee_member_id) → members(tenant_id, project_id, id)`
  `ON DELETE restrict`.
- `check name_not_blank`; `check planned_effort_minutes >= 0` (**L≥0**);
  `check actual_effort_minutes >= 0`; `check duration_positive` (`> 0`);
  `check sort_order >= 0`.
- `check progress_range`: `progress_basis_points between 0 and 10000`;
  `check zero_hundred`: `measurement_method <> 'ZERO_HUNDRED' or progress_basis_points in (0,10000)`
  (mirrors `progress_measurements_zero_hundred_values`, `schema.ts:988`).
- `check constraint_complete`: `(constraint_type is null) = (constraint_date is null)`
  (mirrors `activities_constraint_complete`, `schema.ts:352`).
- `check actual_dates_ordered`: `actual_start is null or actual_finish is null or actual_finish >=
  actual_start` (**R≤S**).
- index `(tenant_id, project_id, parent_task_id)`; index `(tenant_id, project_id, sort_order)`.

**`daily_plan` value non-negativity (daily_plan≥0).** A cheap column check cannot assert
"every jsonb value ≥ 0"; enforce it in the application/domain layer on write (the codebase already
validates rich invariants in JS, e.g. `project-state.ts:185`), consistent with keeping heavy scans
out of Postgres. Advisor item B records the option of a jsonb-scan check constraint.

**Why one self-referential table (former §4.1 rejection reversed).** The worksheet hierarchy that
matters (task D → subtask F) *is* a self-referential task tree — the exact shape the spike modelled
(`subRows`, 2-level, drag re-parent). With backward compatibility withdrawn, the former objection
(non-additive rewrite of `activities` + its mirrors + re-keying) is no longer a cost to avoid but the
**intended** reshape. The vestigial `wbs_nodes`-per-activity glue (`project-command-unit-of-work.ts:551`)
disappears; re-parent (⑥) becomes a single `parent_task_id` update; subtask templates (⑤) create
child rows; every downstream consumer keys on `task_id` directly.

## 4. Scheduling-support schema (minimal — enough for ④)

The advisor simplification: **one task, one assignee**; no skills/m2m. Keep only what the reused
`scheduling.ts` + `capacity.ts` engines need.

- **`project_calendars`** — kept unchanged (`schema.ts:138`). One table serves three roles the ADR
  names (project calendar, company-wide holidays, individual non-working days): each is a calendar
  row with `working_weekdays` + `non_working_dates`. No separate holiday table is needed.
- **`members`** (replaces `resources`; the "簡素な members" of the mandate):
  `id, tenant_id, project_id, name, calendar_id (→ project_calendars), daily_capacity_minutes int
  (check 1..1440)`. **No `cost_rate`** (money is Phase 2). A member's own `calendar_id` encodes their
  individual non-working days; the project default calendar encodes shared holidays.
- **`task_dependencies`** (rename of `dependencies`, keyed by tasks): `predecessor_task_id,
  successor_task_id, type (FS/SS/FF/SF), lag_working_days (≥0)`, unique edge per
  `(predecessor, successor, type)`, distinct-endpoints check — identical semantics to `schema.ts:411`,
  re-keyed onto `tasks`. `scheduling.ts` consumes these unchanged.
- **Assignee** lives on `tasks.assignee_member_id` (nullable FK), replacing the `assignments` m2m
  and `assignment.replace` command. `capacity.ts` (④) reads `(member, task)` demand from this single
  reference instead of the m2m + `unitsPercent`.

**Removed周辺 tables/columns** (were skill/money machinery): `skills`, `resource_skills`,
`activity_skill_requirements`, `assignments`, `resources.cost_rate_minor_per_hour`. The domain
`capacity.ts` retains skill-typed *inputs* but they simply go unused until ④ can decide whether to
trim them; the module stays pure and compiles clean.

## 5. Money and history removed from core

Removed entirely from the core schema (re-derived or rebuilt later):
`activities.budget_minor`, `resources.cost_rate_minor_per_hour`, `worklogs` (+ rate),
`direct_actual_costs`, `progress_measurements` (the dated time series — MVP stores only the single
Current T on the task row), `period_buckets`, `evm_snapshots`, `evm_snapshot_wbs_variances`.

Consequences already traced in code: `project-performance.ts:28` returns `[]` without a baseline and
computes **money** EVM from baseline+worklogs+costs — it is deleted, not ported. The `/performance`
route that surfaced it (`api.ts:377`) is replaced by the effort WBS-grid projection (§7). Money
returns in Phase 2 as `rate × effort` over this same model (ADR 0011 §Consequences "cost layer").

**Why `baseline_*` can be excised (reconciling a verified caveat).** In the *as-built* code, baseline
is load-bearing for core EVM: `evm.ts` takes `baselineBudget/baselineStart/baselineFinish`,
`project-performance.ts` derives snapshots from `record.baseline`, and `evm_snapshots` has an FK to
`baseline_versions`. Ripping baseline out **while keeping the money EVM** would break core — as
independently verified. The excision is safe **only because this design simultaneously replaces the
money EVM with the live effort EVM (§7.4) computed from Current**, which has no baseline dependency.
Baseline itself returns in Phase 2 (freezing/variance) on the new model. So baseline excision and the
EVM rewrite are one atomic change, not two — do not attempt to remove baseline before §7.4 lands.

## 6. Excision plan — exact blast radius and green-keeping wiring

Goal: after excision, the MVP (`apps/web` + `packages/{domain,application,persistence}`) is green
under `pnpm check` = `lint && typecheck && test && test:operations && build` (root `package.json:11`).
"Excise" = delete from the working tree; git history retains it for the Phase-2/3 rebuilds.

### 6.1 Whole workspaces / services to delete

- **`apps/optimizer/`, `apps/simulator/`** — matched by the `apps/*` workspace glob
  (`pnpm-workspace.yaml`); each has `test` (vitest), `typecheck` (tsc), `build` (wrangler dry-run).
  Deleting the directories removes them from `pnpm --recursive` (test/typecheck/build) automatically.
  These are also the **deploy targets** the web bindings point at: `apps/optimizer/wrangler.jsonc`
  defines the Workflow class `StaffingProposalWorkflow` (the `script_name` web's `STAFFING_WORKFLOW`
  targets) plus a `StaffingSolverContainer` Durable Object over the `staffing-solver` image;
  `apps/simulator/wrangler.jsonc` defines the **queue consumers** for `earned-signal-{env}-forecast-runs`
  (the queue web produces to) plus a `ForecastSimulatorContainer` DO over the `forecast-simulator`
  image. Deleting the two apps removes both the workspace members and those deploy targets.
- **`services/staffing-solver/`, `services/forecast-simulator/`** — Python (uv/`pyproject.toml`/
  `Dockerfile`; CP-SAT via `ortools`, Monte-Carlo via FastAPI), **outside** the pnpm workspace (globs
  are only `apps/*`, `packages/*`), with **no `package.json`**. `eslint .` has no Python parser and
  `pnpm -r` skips them, so `pnpm check` never reaches them; there is no build impact. Delete for
  cleanliness and to remove the container images the deleted apps referenced. (They are referenced
  otherwise only by `.github/scripts`/`scripts`, see §6.5.)

**Confirmed clean cut:** `apps/web` has **no TypeScript imports** of optimizer/simulator/services — it
imports only `@earned-signal/{application,domain,persistence}` and local files. The only couplings are
the two runtime bindings + one var in §6.2.

### 6.2 `apps/web` — MCP, workflow, and queue removal

- Delete **`apps/web/src/mcp.ts`** (stateless `agents/mcp` handler; `mcp.ts:7,495`). There is **no
  Durable Object binding** in `wrangler.jsonc` for MCP, so **no `migrations`/`durable_objects`
  wrangler entry** must be edited — removal is clean.
- **`worker.ts`**: drop the `import { createProjectMcpHandler }` and the `mcp = createProjectMcpHandler(...)`
  block (`worker.ts:22,104-107`); drop the `pathname === "/mcp"` branch and MCP fallthrough
  (`worker.ts:124-126`); drop `ensureStaffingWorkflow`/`staffingProposalHash` imports and the
  `staffingSubmission`/`scenarios`/`staffingProposals`/`forecastRuns`/`performance` fields of the
  session (`worker.ts:27-28,60-75`).
- **`wrangler.jsonc`**: remove the `workflows` (`STAFFING_WORKFLOW`, `script_name:
  earned-signal-optimizer-*`) and `queues.producers` (`FORECAST_QUEUE`) blocks from the top level and
  from `env.staging`/`env.production` (`wrangler.jsonc:42-54,89-104,139-154`); remove the
  `MCP_RESOURCE_URL` var (`wrangler.jsonc:20,67,117`). Also remove `MCP_RESOURCE_URL` from
  `apps/web/wrangler.integration.jsonc`. Regenerate `worker-configuration.d.ts`
  (`pnpm --filter @earned-signal/web types:worker`) so the `Env` type drops `STAFFING_WORKFLOW`,
  `FORECAST_QUEUE`, `MCP_RESOURCE_URL`; `worker.ts` then typechecks with those bindings gone. (Leaving
  stale fields in the committed `Env` type would not by itself break typecheck — extra bindings are
  harmless — but the wrangler configs and the code that reads them must be cut.)
- The **forecast queue producer** is used at `api.ts:921` (`context.env.FORECAST_QUEUE.send(...)`) in
  the excised forecast handler (§6.3), so removing the binding is consistent with removing that route.
- **`edge-security.ts`** (kept, edit only): drop the dead MCP branches — `routeKey` mcp case,
  `isComputeMcpMessage` (incl. `"POST:mcp"`), and the `pathname === "/mcp"` in `requiresAuthentication`.
  Harmless if left, but they reference a removed route.
- **`package.json` deps** now unused: `agents`, `@modelcontextprotocol/sdk` (MCP), and — from the grid
  rebuild (§8) — `ag-grid-community`, `ag-grid-react`. Remove them.

### 6.3 `apps/web/src` — route/handler/component removal

Route groups in `api.ts` (paths grepped):
- **Keep (core):** `GET …/projects/{projectId}` (`api.ts:242`), `POST …/projects/{projectId}/commands`
  (`api.ts:594`).
- **Rework:** `GET …/projects/{projectId}/performance` (`api.ts:377`) → replaced by the effort
  WBS-grid projection route (§7).
- **Delete (excised):** staffing-proposals (routes `api.ts:121-168`, handlers `797-845`), scenarios
  (routes `283-373`, handlers `847-858,946-1111`, helpers `415-556`), forecast-runs (routes `305-337`,
  handlers `860-944` incl. `FORECAST_QUEUE.send` at `921`, helper `558-590`). Remove their `createRoute`
  blocks, handlers, and the scenario/staffing/forecast imports (`api.ts:2-4,12-14,19-34,42,47-53`), and
  shrink `ProjectSession` (`api.ts:56-81`) to `service`, `authorizer`, `queryAuthorizer`, `workspace`,
  `close` (drop `scenarioAuthorizer`, `staffingSubmission`, `scenarios`, `staffingProposals`,
  `forecastRuns`; the `performance` field is reworked per §7.5). Also trim the shared **body-limit loop**
  (`api.ts:685-704`) which lists the scenarios/staffing/forecast paths, and remove the forecast branches
  from `app.onError` (`api.ts:1124-1135`).
- Delete supporting web modules: `ScenarioWorkspace.tsx`, `StaffingWorkspace.tsx`, `ForecastPanel.tsx`,
  `scenario-response-contract.ts`, `staffing-contract.ts`, `forecast-contract.ts`,
  `workflow-dispatch.ts`. Delete `gantt.ts` (the bespoke Gantt column is subsumed by the daily plot,
  §8) and `project-analysis.ts` (money EVM view helper) unless a needed piece is folded into the new
  grid.
- **`project-command-contract.ts`**: remove `baseline.publish` + `scenario.publish` from
  `ApiCommandSchema` (`project-command-contract.ts:109-117`), remove `ScenarioPlanCommandSchema`
  (`:96-107`) and `resource.*`/`assignment.replace`, and re-shape `TaskSchema`/`TaskChangesSchema`
  (§7). Remove the money fields (`budgetMinor`, `actualCostMinor`) and skill fields.
- **`project-api-client.ts`**: drop scenario/staffing/forecast/performance client methods; keep
  load + command execute.

### 6.4 `packages/*` — files deleted vs rewritten

- **persistence — delete:** `project-scenario.ts`, `project-staffing-proposal.ts`,
  `project-forecast-run.ts`, `project-performance.ts`. **Rewrite:** `schema.ts` (new tables/enums;
  drop `scenario_status`/`staffing_proposal_status`/`forecast_run_status` enums, `schema.ts:40-54`),
  `project-record.ts`, `project-repository.ts`, `project-workspace.ts`,
  `project-command-unit-of-work.ts` (§7), `demo-project.ts` (§9). Update `index.ts` to stop
  re-exporting the deleted modules (`index.ts:25-27`).
- **application — delete:** `scenario.ts`, `staffing.ts`, `staffing-submission.ts`, `forecast.ts`.
  **Rewrite:** `project-state.ts` (new `ProjectTask`, trimmed command union), `index.ts`
  (`index.ts:4-7`). **Trim:** `project-command-authorizer.ts` — remove
  `createScenarioMutationAuthorizer`/`createStaffingProposalAuthorizer` (`:128-169`); keep the project
  command + query authorizers and the agent progress/actuals scope logic.
- **domain — rewrite** `evm.ts` → an **effort** module (§7); **keep** `scheduling.ts`, `capacity.ts`
  unchanged; update `index.ts` exports.

### 6.5 Tests and operations scripts

- **Delete** test files exclusively about excised subsystems:
  `application/test/{scenario,staffing,staffing-submission,forecast}.test.ts`;
  `persistence/test/{project-scenario,staffing-proposal,forecast-run,scenario-migrations}.test.ts`;
  `apps/web/test/{ForecastPanel.test.tsx,staffing-contract.test.ts,workflow-dispatch.test.ts}`;
  `domain/test/evm.test.ts` (rewritten as the effort golden test).
- **Rewrite** mixed tests that exercise both core and excised concerns:
  `application/test/project-command-authorizer.test.ts` (drop scenario/staffing authorizer suites);
  `persistence/test/migrations.test.ts` (the expected table inventory currently asserts
  `scenario*`/`staffing_proposal*`/`forecast_run*`/`baseline*`/money tables — update to the pruned set);
  `persistence/test/{project-command-unit-of-work,repository}.test.ts` (drop scenario/money cases);
  `apps/web/test/{api,App,edge-security,project-api-client}.test.ts` (drop MCP/scenario/staffing/forecast
  cases; `api.test.ts` in particular carries the MCP/OAuth suite). `worker-fixture.ts` just re-exports
  `worker.ts` and recompiles once trimmed.
- **Stay green as-is** (pure/core, no excised coupling): `domain/test/{scheduling,capacity}.test.ts`;
  `application/test/{project-command-service,project-commands,resource-commands}.test.ts` (the
  effort-model rewrites of the command surface will touch these, but they carry no excised subsystem);
  `persistence/test/{project-access,migration-cli}.test.ts`; `apps/web/test/oidc-auth.test.ts`.
- **`pnpm test:operations`** (`node --test .github/scripts/*.test.mjs`). Only
  `materialize-deploy-config.{mjs,test.mjs}` touch the excised subsystems: the script iterates
  `apps/optimizer/wrangler.jsonc` + `apps/simulator/wrangler.jsonc` (`materialize-deploy-config.mjs:67-68`)
  and requires `MCP_RESOURCE_URL` as the canonical `/mcp` URL (`:62`); the test asserts those paths and
  the `EARNED_SIGNAL_OPTIMIZER_CONFIG`/`EARNED_SIGNAL_SIMULATOR_CONFIG` env
  (`materialize-deploy-config.test.mjs:15-16,37,69-70`). It also transitively drives
  **`scripts/verify-beta-readiness.mjs`**, which validates optimizer/simulator/MCP cross-bindings.
  **All three must be edited** (drop optimizer/simulator configs + MCP; trim `verify-beta-readiness` to
  web-only) or `test:operations` fails. `verify-web-build.test.mjs` and
  `verify-operations-evidence.test.mjs` do **not** reference the excised subsystems and stay green.
  Deploy-time CI scripts outside `pnpm check` — `scripts/beta-e2e.mjs`, `scripts/beta-smoke.mjs` — are
  safe to delete alongside the subsystems.

### 6.6 Excision acceptance

After excision (and before the effort features land), the tree must satisfy: `grep -riE
'scenario|staffing|forecast|baseline|mcp|ag-grid|worklog|budget_minor|cost_rate' packages apps/web/src`
returns only intentional Phase-2/3 references (comments/docs), and `pnpm check` is green. This is the
observable gate for the "clean cut" before feature work.

## 7. Clean schema, write path, application, and projection

### 7.1 Clean initial schema (no legacy) — recommend a squash

There is no data to preserve and no additive constraint. Two options:

- **(A) Squash — recommended.** Delete `packages/persistence/drizzle/*.sql` + `drizzle/meta/*` (the
  15-migration chain, `_journal.json` idx 0–14) and regenerate a **single fresh baseline migration**
  from the rewritten `schema.ts` via `drizzle-kit generate`. Result: one clean `0000` describing the
  final schema, zero legacy DDL, `migrations.test.ts`/`migration-cli.test.ts` rewritten to the single
  baseline.
- **(B) Destructive reshape** — keep the chain and append drop/rename migrations. Rejected: it carries
  15 migrations of money/baseline/scenario DDL forward for no benefit in a pre-production, data-free
  repo.

Recommendation: **(A) squash.** It matches the "no backward compatibility" mandate and yields the
smallest, most legible schema history. Advisor item C confirms.

### 7.2 Write path (reuse the transactional core; simplify the reconciliation)

Keep verbatim the parts that are genuinely good (ADR/CONTEXT design intent, `project-command-unit-of-
work.ts`): the project-row lock, `expectedRevision` optimistic concurrency, canonical-JSON SHA-256
idempotency receipts, append-only `audit_events`, and the **monotonic actuals guard** (now on
`actual_effort_minutes` only; `ActualValueDecreaseError`, `project-command-unit-of-work.ts:62,413-421`).

The reconciliation **collapses** because effort/progress/actuals are now plain task columns:
- Reconstitute `ProjectState` from `tasks` + `task_dependencies` + `members` + `project_calendars`
  (one straightforward load; no join through `wbs_nodes`, no progress/worklog/cost aggregation maps —
  compare the deleted `project-command-unit-of-work.ts:174-395`).
- Apply the command; reconcile: delete removed tasks (+ their dependencies), upsert remaining tasks
  with **all native columns** (L, T bp, W, `daily_plan`, `daily_plan_locked`, meta B/C/E/G/H/I,
  R/S, `assignee_member_id`, `parent_task_id`, `sort_order`, `measurement_method`,
  `duration_working_days`, calendar/constraint), re-insert dependencies. **No** `wbs_nodes` creation
  (`:551-616`), **no** `progress_measurements` upsert (`:640-662`), **no** worklog/cost deltas
  (`:664-694`), **no** baseline snapshot block (`:709-836`).
- W monotonic guard retained as an application rule even though W is now a column (a decrease should be
  a correction, not a silent overwrite). Advisor item D confirms keeping it.

### 7.3 Application re-composition

- `ProjectTask` (`project-state.ts:52`) → new shape: `id, parentId, sortOrder, name, process, product,
  reviewRef, changeRef, note, contract, assigneeMemberId, plannedEffortMinutes, progressBasisPoints,
  actualEffortMinutes, measurementMethod, dailyPlan, dailyPlanLocked, durationWorkingDays, calendarId,
  constraint, actualStart, actualFinish, dependencies`. Drop `wbs`, `wbsParentId`, `owner`, `budget`,
  `actualCost`, `requiredSkillIds`. Validation (`project-state.ts:185`) updated: L≥0 int, W≥0 int,
  `daily_plan` values ≥0, `M = Σ daily`, parent-not-self + acyclic, R≤S, T range + 0/100 rule; the
  `calculateSchedule` cycle/constraint check stays (drop the `calculateProjectCapacity` call from
  core validation until ④).
- `ProjectCommand` union → `task.add | task.update | task.delete | member.add | member.update |
  member.delete`. Drop `baseline.publish`, `scenario.publish`, `assignment.replace`, `resource.*`→
  `member.*`. Assignee changes ride on `task.update` (`assigneeMemberId`).
- Idempotency/optimistic-concurrency/audit **service** (`project-command-service.ts`) unchanged in
  spirit. Authorizer keeps OWNER/EDITOR-writes / VIEWER-read and agent progress/actuals scope
  (`project-command-authorizer.ts:63-91`); the agent's direct-write field set becomes
  `{progressBasisPoints, actualEffortMinutes}`.

### 7.4 Effort EVM as a shared pure module (single formula source)

A new pure module (domain) computes, with **no rounding**, div0→`"-"`, planned-progress→`0`:
- per task: K = L/8pd; M = Σ daily; N = Σ daily ≤ status date; O = N/M; P/Q from first/last non-zero
  daily; U = f(T); V = M×T; X = V−W (all in person-hours, K in person-days);
- project rollup (person-days): BAC/PV/EV/AC = Σ over tasks of M/8, N/8, (M×T)/8, W/8; SV, CV,
  SPI=EV/PV, CPI=EV/AC.

This module is the **single source** consumed by (a) the server-side WBS-grid projection
(authoritative) and (b) the web client for optimistic local recompute on inline edit (avoid a reload
flash), exactly as the previous draft's approved item 10 intended — now on the effort model. It
replaces the money `evm.ts`.

### 7.5 Flat WBS-grid read projection (with derived columns + role seam)

A dedicated flat projection returns **one row per task** with the 23 columns **including** derived
K/M/N/O/P/Q/U/V/X and the daily plot, plus the project rollup, computed by §7.4. Keep the
mutation-input `ProjectState` lean (stored inputs only); do not stuff derived columns into it. This
projection is the **single choke point** where ⑦ later strips role-sensitive fields (capacity, and the
Phase-2 rate) for the general role — **place the seam now, implement the filtering in ⑦** (do not
filter in this slice). It supersedes the money `/performance` route.

## 8. Web grid (reused design from the previous draft's §4.6)

Unchanged from the prior GO'd approach; restated for completeness. Replace AG Grid with a headless
**TanStack Table v8 + TanStack Virtual v3** flat grid per `spikes/tanstack-grid/FINDINGS.md`:
two-axis virtualization in one scroll container (virtualize rows and the **daily** columns only; render
the 23 meta columns always, sticky-left subset + sticky header); **`paddingStart` on both
virtualizers** (top gotcha #1); mount **`DndContext` stably** even though drag re-parent is ⑥ (gotcha
#2); **hand-written cells** bypassing `flexRender` (gotcha #5); inline edit / clipboard / keyboard nav /
process+status coloring on meta columns; the daily plot renders **read-only** in this slice (cell
editing = ④ manual-lock). Edits dispatch the existing typed commands through the existing
`executeCommand` save/reload/conflict plumbing — only the rendering surface changes. Remove
`ag-grid-community`/`ag-grid-react` (§6.2). The bespoke Gantt column (`gantt.ts`) is retired in favor
of the daily-plot columns.

## 9. Anonymized fixtures

A **seeded synthetic generator** (deterministic PRNG, mirroring the spike's `src/data.ts`) producing a
`PersistedProjectRecord` (new shape) or a command sequence with: hundreds–few-thousand tasks in a
**2-level** parent/subtask shape via `parent_task_id`; populated L, a **precomputed `daily_plan`** (a
plausible placement — the scheduler is ④), T (free 0–1 under `PHYSICAL_PERCENT`, the
"physical-percent"-equivalent), W, and the six meta columns filled with **generic anonymized labels**
("Phase A", "Product 1", "Member 01") — no client/vendor/product/contract names, no real numbers.
Wire it to the demo/seed entry (`persistence/index.ts`) and the web preview. Golden values are
self-derived from §2 formulas on these synthetic inputs; `.wbs-private/` is never read.

## 10. Implementation task decomposition (ordered, each with observable acceptance)

Clean cut first, then rebuild the slice. Each task is independently delegatable.

**T0 — Excise.** Perform §6 (delete workspaces/services/files, trim web routes/deps/wrangler, delete
excised tests, edit `.github/scripts`). *Acceptance*: `pnpm check` green with the excised code gone;
§6.6 grep returns only intentional references; `apps/optimizer`/`apps/simulator`/`services/*` absent;
`ag-grid-*`/`agents`/`@modelcontextprotocol/sdk` absent from `apps/web/package.json`.

**T1 — Clean schema + squash migration.** Rewrite `schema.ts` to §3–§5; regenerate a single baseline
migration (§7.1 option A); rewrite `project-record.ts`. *Acceptance*: a fresh DB migrates from empty to
the new schema in one step; `drizzle` schema check clean; no `wbs_nodes`/`activities`/money/baseline/
scenario/staffing/forecast tables exist; `migrations.test.ts` green against the single baseline.

**T2 — Effort domain (EVM) + pure derivations.** New effort module (§7.4). *Acceptance*: unit tests
reproduce the §2 formula values on **anonymized fixtures** (golden), incl. div0→`"-"`,
planned-progress→`0`; person-day = minutes/60/8 exact on whole-minute inputs; `scheduling.ts`/
`capacity.ts` tests still green.

**T3 — Application model + commands.** New `ProjectTask`, trimmed `ProjectCommand`, updated validation
+ authorizer (§7.3). *Acceptance*: `applyProjectCommand` round-trips the new fields; invalid L/T/W/R≤S/
parent-self/daily-plan-negative rejected; agent scope limited to progress/actuals; command-service
idempotency/concurrency tests green.

**T4 — Contract + WBS-grid projection.** New `TaskSchema`/`TaskChangesSchema`, `toCommand`/`fromCommand`;
flat projection returning 23-col rows incl. derived (via T2) + rollup; place (do not apply) the ⑦ role
seam (§7.5). *Acceptance*: `toCommand`/`fromCommand` round-trip the new fields; the projection's derived
columns equal the T2 golden values for an N-task fixture; the `/performance` money route is gone and the
grid route returns effort EVM.

**T5 — Persistence write path.** Simplified reconciliation (§7.2). *Acceptance*: a `task.update`
carrying L/meta/`dailyPlan`/R/S/T/W/assignee persists and reloads **identically**; the W-decrease guard
fires; revision/idempotency/audit behavior unchanged; no rows appear in any removed table (they no
longer exist).

**T6 — Anonymized fixtures + seed.** §9. *Acceptance*: the seed loads; the T4 projection returns the
expected row count/columns; a repo string scan finds **no** real-data tokens; same seed ⇒ deterministic.

**T7 — Web TanStack grid.** §8; remove AG Grid. *Acceptance* (UI checkpoint): `apps/web` **production
build** succeeds; a few-thousand-row fixture renders 23 meta + virtualized daily columns with frozen
header/left; an inline L/T/W edit persists through `executeCommand` and survives reload; production-build
long-task spot-check shows no sustained >50 ms blocking (spike parity); `ag-grid-*` absent from the
bundle.

**T8 — End-to-end.** *Acceptance*: load fixture → grid shows 23 cols + daily plot → edit L/T/W → derived
K/M/N/O/V/X + rollup recompute to the §2 values → save → reload parity. No excised surface remains.

## 11. Open items requiring advisor decision

- **A. Assignee representation.** Recommend `assignee_member_id` (nullable FK → `members`) so ④'s
  capacity scheduler can attach per-person capacity, with the grid's J column showing `members.name`.
  Alternative: a free-text `assignee` column (no capacity link). One-task-one-name + the ④ scheduler
  argue for the FK; confirm.
- **B. `daily_plan` value non-negativity.** Recommend application/domain validation (no jsonb-scan check
  constraint), consistent with the codebase. Confirm, or require a Postgres jsonb-scan check.
- **C. Migration strategy.** Recommend squash to a single fresh baseline (§7.1 A) over a destructive
  reshape chain (B). Confirm.
- **D. W monotonic guard.** Recommend keeping the "actual effort cannot decrease" guard even though W is
  now a plain column. Confirm, or allow free correction.
- **E. `duration_working_days` vs the daily plot.** Kept as a scheduling-window input feeding
  `scheduling.ts` for this slice. In ④ the capacity-aware placement may make duration a **derived**
  span of the daily plot. Confirm keeping it an input for now (recommended) vs deriving it immediately.
- **F. Progress storage unit.** Recommend integer basis points `progress_basis_points` (0–10000),
  reusing the existing convention + `ZERO_HUNDRED` check, with T = /10000. Alternative:
  `numeric(5,4)` 0–1. Confirm.
- **G. `measurement_method` retention.** Kept so `ZERO_HUNDRED` tasks constrain T to 0/100 while the
  effort-grid default is `PHYSICAL_PERCENT` (T free). Confirm keeping the enum, or drop it and make all
  tasks free-percent.
- **H. `capacity.ts` skill inputs.** The pure engine keeps skill-typed inputs that go unused in the MVP
  core. Confirm leaving it untrimmed until ④ (recommended; minimal churn) vs trimming skills now.

## 12. Advisor decisions (final — authoritative; supersedes conflicting parts of §3/§7)

Status: **Approved for implementation (2026-07-20, Fable/advisor)**, with the trims below. Where this
section conflicts with §3 (schema) or §7.2/§7.3 (write path / app model), **§12 wins**. Principle:
step ② `tasks` core carries **exactly** the 23 worksheet columns (A–X) + hierarchy + the minimal
scheduling *links*; scheduler-specific per-task inputs are deferred to ④ where the placement
algorithm is concrete. No money-first- or scheduler-era scaffolding that the worksheet lacks.

§11 rulings:
- **A — APPROVED** `assignee_member_id` nullable FK → `members`; grid J shows `members.name`.
- **B — APPROVED** `daily_plan` value ≥ 0 validated in the application/domain layer (no jsonb-scan CHECK).
- **C — APPROVED** squash to a single fresh `0000` baseline migration; delete the 15-migration chain.
- **D — OVERRIDE: DROP the W monotonic guard.** `actual_effort_minutes` is a directly-entered
  worksheet value; downward corrections must be allowed. Remove `ActualValueDecreaseError` for W. (No
  money/cost actuals exist anymore, so the guard has no remaining subject.)
- **E — OVERRIDE: DROP `duration_working_days` from the `tasks` core.** It is not a worksheet column;
  the scheduling window is emergent (P/Q derive from `daily_plan`). ④ decides how to feed
  `scheduling.ts` (compute a span from effort×capacity, or refactor). Re-adds are cheap (no back-comp).
- **F — APPROVED** integer `progress_basis_points` (0–10000), T = /10000.
- **G — OVERRIDE: DROP `measurement_method`** (and its `zero_hundred` check). The worksheet treats T as
  free 0–1 always; U = f(T). Milestone 0/100 semantics can be re-added later if ever needed.
- **H — APPROVED** leave `capacity.ts` untrimmed until ④.

Additional trims (my refinement, same principle):
- **DROP `constraint_type` / `constraint_date` from `tasks` core** — defer schedule constraints to ④.
- **DROP task-level `calendar_id`** — the working calendar resolves from the assignee's
  `members.calendar_id`; unassigned tasks fall back to `projects.default_calendar_id`. No per-task
  calendar override in step ②.

**Final `tasks` columns (authoritative).** `id, tenant_id, project_id, parent_task_id (null, self-FK),
sort_order, name, process, product, review_ref, change_ref, note, contract (six meta NOT NULL DEFAULT
''), assignee_member_id (null, FK→members), planned_effort_minutes (int NN d0, ≥0 = L),
progress_basis_points (int NN d0, 0–10000 = T), actual_effort_minutes (int NN d0, ≥0 = W), daily_plan
(jsonb NN d'{}'), daily_plan_locked (bool NN d false), actual_start (date null = R), actual_finish
(date null = S), created_at, updated_at`. Constraints: `unique(tenant,project,id)`; self-FK +
`not_own_parent`; project FK cascade; assignee FK restrict; `name_not_blank`; `planned_effort_minutes
≥0`; `actual_effort_minutes ≥0`; `sort_order ≥0`; `progress_basis_points 0..10000`;
`actual_dates_ordered (R≤S)`. Indexes: `(tenant,project,parent_task_id)`, `(tenant,project,sort_order)`.
Removed vs §3: `measurement_method` (+`zero_hundred`), `duration_working_days` (+`duration_positive`),
`calendar_id`, `constraint_type`/`constraint_date` (+`constraint_complete`).

**Delegation split (advisor).**
- **Backend rebuild (packages/* + non-web excise + ops scripts)** = **T0(non-web)+T1+T2+T3+T4(projection
  as an application/domain function)+T5+T6** — one delegated task. Gate: `pnpm --filter './packages/**'`
  lint+typecheck+test green, `pnpm test:operations` green, golden tests reproduce §2 values, fixtures
  load deterministically, §6.6 grep clean within `packages/` and `.github/scripts`. **Does not touch
  `apps/web`** (root `pnpm check` will stay red on web until the web task) — that is expected.
- **Web rebuild + integration (apps/web)** = **T0(web parts)+T7** — delegated **after** backend accepted;
  wires the projection route, rebuilds the grid on TanStack, brings root `pnpm check` fully green, and is
  the **UI checkpoint** (advisor surfaces screenshots).
- **T8 end-to-end** verifies the whole slice.
- No commits/pushes; advisor reviews before any commit. `.wbs-private/` never read.
