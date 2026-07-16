# Staffing solver

Python 3.12 / OR-Tools CP-SAT service for deterministic, constraint-based staffing proposals. It does not mutate projects, publish scenarios, or call an LLM.

## HTTP contract

- `GET /health` returns `{"status":"ok"}`.
- `POST /solve` accepts and returns versioned `staffing.v1` JSON.
- Models are strict: unknown fields, coercion of numeric strings, duplicate IDs, out-of-horizon dates, and dangling references are rejected with HTTP 422.
- OpenAPI is available at `/openapi.json`.

Each unfinished task must provide human-confirmed `remainingEffortMinutes`, sorted `workingDates`, `currentStartDate`, duration bounds, skill requirements, typed FS/SS/FF/SF dependencies with `lagWorkingDays`, any existing date constraint, and a parallel-resource bound. Completed tasks are supplied separately as fixed start/finish boundaries so dependencies on them remain enforceable. Task duration advances through that task's ordered working dates. Dependency lag advances through the project's ordered `defaultWorkingDates`, matching the Application scheduler's project-default-calendar lag basis; it is not calendar-day lag. Each resource supplies a sorted per-date `availability` series, capacity, rate, skills, and the fixed load already consumed by completed-task Assignments. The current Application adapter supplies every horizon date and uses zero capacity on a Resource's non-working dates. Assignments use one constant `unitsPercent` for the selected task duration so the result maps directly to `assignment.replace`.

Hard constraints cover deadline, modeled planned labor cost, total overtime, changed Task/Resource Assignment pairs, changed Task schedules, candidate Resources, and Skill coverage. Candidates must be explicitly supplied with `isCandidate: true`; `maxCandidateResources` bounds their use. `maxCostMinor` includes the fixed completed-task load and the proposed unfinished-task load over the optimization horizon; it is not EAC and does not include an overtime premium. For each Resource/date, overtime is the positive difference between fixed plus proposed modeled demand and that date's available capacity. `maxTotalOvertimeMinutes` bounds the sum across all Resource/date rows in the solver request, and overtime still contributes productive effort. The Application acceptance check independently recomputes cost and overtime for the complete proposed Project plan.

Successful responses contain every task in `taskDurations` and `taskStarts`, detailed task plans, `selectedCandidateResourceIds`, and structured `assignment.replace` commands. `changedAssignmentPairCount` counts each Task/Resource pair whose presence or units percentage differs from `currentAssignments`; it does not count replacement commands. `totalCostMinor` and `totalOvertimeMinutes` round fractional minor units/minutes upward for transport, while constraints and optimization use their exact scaled integer expressions.

Statuses are distinct:

- `OPTIMAL`: every lexicographic objective stage was proven optimal.
- `FEASIBLE`: a solution exists but the current objective stage was not proven optimal.
- `INFEASIBLE`: no solution exists; diagnostics contain a sufficient, not necessarily minimum, assumption core when available.
- `UNKNOWN`: the fixed time limit elapsed without establishing a solution.
- `MODEL_INVALID`: OR-Tools rejected the generated model.

## Reproducibility

The request must contain exactly this objective order: `MINIMIZE_FINISH`, `MINIMIZE_OVERTIME`, `MINIMIZE_COST`, then `MINIMIZE_CHANGE`. No reordering, arbitrary expression, or weight is accepted. `MINIMIZE_CHANGE` and `maxChangedAssignmentPairs` both use the changed Task/Resource pair count. Each proven lexicographic stage is pinned before optimizing the next. Further stages minimize changed Task count, candidate-Resource count, an ID-sorted weighted sum of Assignment units, and an ID-sorted weighted sum of start-day indices where those expressions were not already optimized. The response records every completed stage's name, value, and best bound. Weighted sums can collide, so these stages improve stable selection but do not prove that the feasible plan is unique.

OR-Tools and every runtime dependency are pinned with hashes in `uv.lock`. The container also pins the Python base-image digest and the `uv` installer version, then installs the project with `uv sync --locked`; a stale lockfile therefore fails the build instead of being silently re-resolved. The response also records the OR-Tools version, random seed (`20260716`), search-worker count (`1`), wall-clock limit per stage (five seconds), and deterministic-time limit per stage (`1.0`). An `OPTIMAL` response means all eight objective and stability stages were proven and pinned in the documented order; it proves those recorded aggregate values, not uniqueness of the selected plan. `FEASIBLE` means the current stage produced a solution without proving its bound. Persist the complete request, response, Application result, service image digest, and Proposal Run algorithm version when audit-grade replay is required.

## Run and test

```sh
python3.12 -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/pytest
.venv/bin/uvicorn staffing_solver.api:app --host 127.0.0.1 --port 8080
```

```sh
docker build -t earned-signal-staffing-solver .
docker run --rm -p 8080:8080 earned-signal-staffing-solver
```

## Deliberate limitations

- At most 100 tasks, 100 resources, and a 366-day horizon.
- Assignments are constant for a task; daily assignment editing, task preemption, skill-specific effort, overtime premiums, hiring lead time, and probabilistic productivity are outside `staffing.v1`.
- Required skills follow current domain semantics: every required skill must be held by at least one assigned resource that contributes effort. They do not partition effort by skill.
- The service trusts confirmed remaining effort and availability; it never invents those numeric inputs.
- The calling Application layer must treat every response as untrusted. It verifies the source revision and solver metadata, accepts only candidate-Resource additions, complete Assignment replacements, durations, and optional starts, and reapplies those changes through normal Project validation. It independently recomputes schedule constraints, confirmed-effort coverage, capacity, total overtime, planned labor cost, Assignment-pair changes, Task schedule changes, candidate use, and Skill coverage. A READY result is linked to a draft Scenario and still requires human publication.
