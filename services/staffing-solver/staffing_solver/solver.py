from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from math import ceil

from ortools import __version__ as ortools_version
from ortools.sat.python import cp_model

from .contracts import (
    AssignmentReplaceCommand,
    Diagnostic,
    ObjectiveValue,
    PlannedAssignment,
    Solution,
    SolveRequest,
    SolveResponse,
    SolveStatus,
    TaskPlan,
    TaskDuration,
    TaskStart,
)

DETERMINISTIC_SEED = 20260716
WORKERS = 1
TIME_LIMIT_SECONDS_PER_STAGE = 5
DETERMINISTIC_TIME_LIMIT_PER_STAGE = 1.0
COST_DENOMINATOR = 60 * 100
MINUTES_SCALE = 100


@dataclass
class ModelArtifacts:
    model: cp_model.CpModel
    patterns: dict[tuple[str, int, int], cp_model.IntVar]
    units: dict[tuple[str, str], cp_model.IntVar]
    present: dict[tuple[str, str], cp_model.IntVar]
    active: dict[tuple[str, int], cp_model.IntVar]
    start: dict[str, cp_model.IntVar]
    finish: dict[str, cp_model.IntVar]
    duration: dict[str, cp_model.IntVar]
    changed: dict[tuple[str, str], cp_model.IntVar]
    schedule_changed: dict[str, cp_model.IntVar]
    candidate_resource_used: dict[str, cp_model.IntVar]
    overtime_scaled: dict[tuple[str, int], cp_model.IntVar]
    assumption_names: dict[int, str]
    objective_vars: list[tuple[str, cp_model.LinearExpr | cp_model.IntVar]]


def _day_index(value: date, request: SolveRequest) -> int:
    return (value - request.horizon.start_date).days


def _guard(model: cp_model.CpModel, name: str, assumption_names: dict[int, str]) -> cp_model.IntVar:
    literal = model.new_bool_var(f"assume:{name}")
    model.add_assumption(literal)
    assumption_names[literal.index] = name
    return literal


def _build_model(request: SolveRequest) -> ModelArtifacts:
    model = cp_model.CpModel()
    day_count = (request.horizon.end_date - request.horizon.start_date).days + 1
    tasks = {task.id: task for task in request.tasks}
    resources = {resource.id: resource for resource in request.resources}
    availability = {
        (resource.id, _day_index(item.date, request)): item.capacity_minutes
        for resource in request.resources
        for item in resource.availability
    }
    fixed_load_scaled = {
        (resource.id, _day_index(item.date, request)): item.fixed_load_scaled_minutes
        for resource in request.resources
        for item in resource.availability
    }
    fixed_tasks = {task.id: task for task in request.fixed_tasks}
    current = {
        (assignment.task_id, assignment.resource_id): assignment.units_percent
        for assignment in request.current_assignments
    }
    allowed_units = [0, *request.allowed_units_percent]
    assumption_names: dict[int, str] = {}

    patterns: dict[tuple[str, int, int], cp_model.IntVar] = {}
    active: dict[tuple[str, int], cp_model.IntVar] = {}
    start: dict[str, cp_model.IntVar] = {}
    finish: dict[str, cp_model.IntVar] = {}
    duration: dict[str, cp_model.IntVar] = {}
    for task in request.tasks:
        eligible_days = [_day_index(value, request) for value in task.working_dates]
        task_patterns: list[tuple[int, int, cp_model.IntVar]] = []
        for length in range(task.min_duration_working_days, task.max_duration_working_days + 1):
            for start_ordinal in range(0, len(eligible_days) - length + 1):
                variable = model.new_bool_var(f"pattern:{task.id}:{start_ordinal}:{length}")
                patterns[(task.id, start_ordinal, length)] = variable
                task_patterns.append((start_ordinal, length, variable))
        model.add_exactly_one(variable for _, _, variable in task_patterns)
        start[task.id] = model.new_int_var(0, day_count - 1, f"start:{task.id}")
        finish[task.id] = model.new_int_var(0, day_count - 1, f"finish:{task.id}")
        duration[task.id] = model.new_int_var(
            task.min_duration_working_days, task.max_duration_working_days, f"duration:{task.id}"
        )
        model.add(start[task.id] == sum(eligible_days[s] * var for s, _, var in task_patterns))
        model.add(finish[task.id] == sum(eligible_days[s + length - 1] * var for s, length, var in task_patterns))
        model.add(duration[task.id] == sum(length * var for _, length, var in task_patterns))
        for day in range(day_count):
            active_var = model.new_bool_var(f"active:{task.id}:{day}")
            active[(task.id, day)] = active_var
            containing = [
                var
                for s, length, var in task_patterns
                if day in eligible_days[s : s + length]
            ]
            model.add(active_var == (sum(containing) if containing else 0))

        if task.constraint is not None:
            constraint_index = _day_index(task.constraint.date, request)
            guard = _guard(model, f"taskConstraint:{task.id}:{task.constraint.type}", assumption_names)
            if task.constraint.type == "START_NO_EARLIER_THAN":
                model.add(start[task.id] >= constraint_index).only_enforce_if(guard)
            elif task.constraint.type == "FINISH_NO_LATER_THAN":
                model.add(finish[task.id] <= constraint_index).only_enforce_if(guard)
            elif task.constraint.type == "MUST_START_ON":
                model.add(start[task.id] == constraint_index).only_enforce_if(guard)
            else:
                model.add(finish[task.id] == constraint_index).only_enforce_if(guard)

    default_working_indices = [_day_index(value, request) for value in request.default_working_dates]

    def advanced_default_day(anchor: int, amount: int) -> int:
        result = anchor
        for _ in range(amount):
            result = next((value for value in default_working_indices if value > result), day_count)
        return result

    for task in request.tasks:
        for dependency in task.dependencies:
            successor_anchor = start[task.id] if dependency.type in ("FS", "SS") else finish[task.id]
            offset = dependency.lag_working_days + (1 if dependency.type == "FS" else 0)
            fixed_predecessor = fixed_tasks.get(dependency.predecessor_task_id)
            if fixed_predecessor is not None:
                predecessor_date = (
                    fixed_predecessor.finish_date
                    if dependency.type in ("FS", "FF")
                    else fixed_predecessor.start_date
                )
                model.add(successor_anchor >= advanced_default_day(_day_index(predecessor_date, request), offset))
                continue
            predecessor_anchor = (
                finish[dependency.predecessor_task_id]
                if dependency.type in ("FS", "FF")
                else start[dependency.predecessor_task_id]
            )
            required = model.new_int_var(0, day_count, f"dependencyRequired:{task.id}:{dependency.predecessor_task_id}")
            model.add_allowed_assignments(
                [predecessor_anchor, required],
                [(anchor, advanced_default_day(anchor, offset)) for anchor in range(day_count)],
            )
            model.add(successor_anchor >= required)

    if request.constraints.deadline is not None:
        guard = _guard(model, "deadline", assumption_names)
        deadline_index = _day_index(request.constraints.deadline, request)
        for task in request.tasks:
            model.add(finish[task.id] <= deadline_index).only_enforce_if(guard)
        for task in request.fixed_tasks:
            model.add(_day_index(task.finish_date, request) <= deadline_index).only_enforce_if(guard)

    units: dict[tuple[str, str], cp_model.IntVar] = {}
    present: dict[tuple[str, str], cp_model.IntVar] = {}
    changed: dict[tuple[str, str], cp_model.IntVar] = {}
    active_units: dict[tuple[str, str, int], cp_model.IntVar] = {}
    task_loads: dict[str, list[cp_model.IntVar]] = {task.id: [] for task in request.tasks}
    resource_day_loads: dict[tuple[str, int], list[cp_model.IntVar]] = {
        (resource.id, day): [] for resource in request.resources for day in range(day_count)
    }
    for task in request.tasks:
        for resource in request.resources:
            key = (task.id, resource.id)
            unit = model.new_int_var_from_domain(cp_model.Domain.from_values(allowed_units), f"units:{task.id}:{resource.id}")
            is_present = model.new_bool_var(f"present:{task.id}:{resource.id}")
            units[key] = unit
            present[key] = is_present
            model.add(unit == 0).only_enforce_if(is_present.Not())
            model.add(unit >= 1).only_enforce_if(is_present)

            current_units = current.get(key, 0)
            is_changed = model.new_bool_var(f"changed:{task.id}:{resource.id}")
            changed[key] = is_changed
            model.add(unit == current_units).only_enforce_if(is_changed.Not())
            model.add(unit != current_units).only_enforce_if(is_changed)

            contributed: list[cp_model.IntVar] = []
            for day in range(day_count):
                active_unit = model.new_int_var(0, 100, f"activeUnits:{task.id}:{resource.id}:{day}")
                model.add_multiplication_equality(active_unit, [active[(task.id, day)], unit])
                active_units[(task.id, resource.id, day)] = active_unit
                capacity = availability.get((resource.id, day), 0)
                if capacity > 0:
                    scaled_load = model.new_int_var(0, capacity * 100, f"load:{task.id}:{resource.id}:{day}")
                    model.add(scaled_load == capacity * active_unit)
                    task_loads[task.id].append(scaled_load)
                    resource_day_loads[(resource.id, day)].append(scaled_load)
                    contributed.append(scaled_load)
            model.add(sum(contributed) >= is_present) if contributed else model.add(is_present == 0)

        model.add(sum(present[(task.id, resource.id)] for resource in request.resources) <= task.max_parallel_resources)
        model.add(sum(task_loads[task.id]) >= task.remaining_effort_minutes * MINUTES_SCALE)
        for skill in task.required_skills:
            guard = _guard(model, f"skill:{task.id}:{skill}", assumption_names)
            skilled = [present[(task.id, resource.id)] for resource in request.resources if skill in resource.skills]
            constraint = model.add(sum(skilled) >= 1) if skilled else model.add(0 >= 1)
            constraint.only_enforce_if(guard)

    schedule_changed: dict[str, cp_model.IntVar] = {}
    for task in request.tasks:
        duration_changed = model.new_bool_var(f"durationChanged:{task.id}")
        model.add(duration[task.id] == task.current_duration_working_days).only_enforce_if(duration_changed.Not())
        model.add(duration[task.id] != task.current_duration_working_days).only_enforce_if(duration_changed)
        start_changed = model.new_bool_var(f"startChanged:{task.id}")
        current_start_index = _day_index(task.current_start_date, request)
        model.add(start[task.id] == current_start_index).only_enforce_if(start_changed.Not())
        model.add(start[task.id] != current_start_index).only_enforce_if(start_changed)
        variable = model.new_bool_var(f"scheduleChanged:{task.id}")
        schedule_changed[task.id] = variable
        model.add_max_equality(variable, [duration_changed, start_changed])

    overtime_scaled: dict[tuple[str, int], cp_model.IntVar] = {}
    for resource in request.resources:
        for day in range(day_count):
            fixed_load = fixed_load_scaled.get((resource.id, day), 0)
            load = sum(resource_day_loads[(resource.id, day)]) + fixed_load
            regular_scaled = availability.get((resource.id, day), 0) * MINUTES_SCALE
            maximum_load = sum(
                availability.get((resource.id, day), 0) * max(request.allowed_units_percent)
                for _task in request.tasks
            ) + fixed_load
            overtime = model.new_int_var(
                0,
                max(0, maximum_load - regular_scaled),
                f"overtime:{resource.id}:{day}",
            )
            overtime_scaled[(resource.id, day)] = overtime
            model.add_max_equality(overtime, [load - regular_scaled, 0])

    total_overtime_scaled = sum(overtime_scaled.values())
    if request.constraints.max_total_overtime_minutes is not None:
        guard = _guard(model, "totalOvertime", assumption_names)
        model.add(
            total_overtime_scaled <= request.constraints.max_total_overtime_minutes * MINUTES_SCALE
        ).only_enforce_if(guard)

    variable_cost_numerator = sum(
        availability.get((resource.id, day), 0)
        * active_units[(task.id, resource.id, day)]
        * resource.hourly_rate_minor
        for task in request.tasks
        for resource in request.resources
        for day in range(day_count)
    )
    fixed_cost_numerator = sum(
        fixed_load_scaled.get((resource.id, day), 0) * resource.hourly_rate_minor
        for resource in request.resources
        for day in range(day_count)
    )
    cost_numerator = variable_cost_numerator + fixed_cost_numerator
    if request.constraints.max_cost_minor is not None:
        guard = _guard(model, "cost", assumption_names)
        model.add(cost_numerator <= request.constraints.max_cost_minor * COST_DENOMINATOR).only_enforce_if(guard)

    if request.constraints.max_changed_assignment_pairs is not None:
        guard = _guard(model, "changedAssignmentPairs", assumption_names)
        model.add(sum(changed.values()) <= request.constraints.max_changed_assignment_pairs).only_enforce_if(guard)
    if request.constraints.max_schedule_changes is not None:
        guard = _guard(model, "scheduleChanges", assumption_names)
        model.add(sum(schedule_changed.values()) <= request.constraints.max_schedule_changes).only_enforce_if(guard)

    candidate_resource_used: dict[str, cp_model.IntVar] = {}
    for resource in request.resources:
        used = model.new_bool_var(f"candidateResourceUsed:{resource.id}")
        candidate_resource_used[resource.id] = used
        resource_presence = [present[(task.id, resource.id)] for task in request.tasks]
        if resource.is_candidate:
            model.add_max_equality(used, resource_presence)
        else:
            model.add(used == 0)
    if request.constraints.max_candidate_resources is not None:
        guard = _guard(model, "candidateResources", assumption_names)
        model.add(sum(candidate_resource_used.values()) <= request.constraints.max_candidate_resources).only_enforce_if(guard)

    project_finish = model.new_int_var(0, day_count - 1, "projectFinish")
    fixed_finishes = [_day_index(task.finish_date, request) for task in request.fixed_tasks]
    model.add_max_equality(project_finish, [*finish.values(), *fixed_finishes])
    requested_objectives: dict[str, tuple[str, cp_model.LinearExpr | cp_model.IntVar]] = {
        "MINIMIZE_FINISH": ("finishDayIndex", project_finish),
        "MINIMIZE_COST": ("costNumerator", cost_numerator),
        "MINIMIZE_OVERTIME": ("overtimeScaledMinutes", total_overtime_scaled),
        "MINIMIZE_CHANGE": ("changedAssignmentPairCount", sum(changed.values())),
    }
    objective_vars = [requested_objectives[priority] for priority in request.objective.priorities]
    stable_objectives: list[tuple[str, cp_model.LinearExpr | cp_model.IntVar]] = [
        ("scheduleChangeCount", sum(schedule_changed.values())),
        ("candidateResourceCount", sum(candidate_resource_used.values())),
        ("changedAssignmentPairCount", sum(changed.values())),
        (
            "stableAssignmentScore",
            sum(
                (index + 1) * units[key]
                for index, key in enumerate(sorted(units))
            ),
        ),
        ("stableStartScore", sum((index + 1) * start[task_id] for index, task_id in enumerate(sorted(start)))),
    ]
    used_names = {name for name, _ in objective_vars}
    objective_vars.extend(item for item in stable_objectives if item[0] not in used_names)
    return ModelArtifacts(
        model=model,
        patterns=patterns,
        units=units,
        present=present,
        active=active,
        start=start,
        finish=finish,
        duration=duration,
        changed=changed,
        schedule_changed=schedule_changed,
        candidate_resource_used=candidate_resource_used,
        overtime_scaled=overtime_scaled,
        assumption_names=assumption_names,
        objective_vars=objective_vars,
    )


def _configured_solver() -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.random_seed = DETERMINISTIC_SEED
    solver.parameters.num_search_workers = WORKERS
    solver.parameters.max_time_in_seconds = TIME_LIMIT_SECONDS_PER_STAGE
    solver.parameters.max_deterministic_time = DETERMINISTIC_TIME_LIMIT_PER_STAGE
    return solver


def _response(request: SolveRequest, status: SolveStatus, **kwargs: object) -> SolveResponse:
    return SolveResponse(
        request_id=request.request_id,
        status=status,
        solver_version=ortools_version,
        deterministic_seed=DETERMINISTIC_SEED,
        workers=WORKERS,
        time_limit_seconds_per_stage=TIME_LIMIT_SECONDS_PER_STAGE,
        deterministic_time_limit_per_stage=DETERMINISTIC_TIME_LIMIT_PER_STAGE,
        **kwargs,
    )


def solve(request: SolveRequest) -> SolveResponse:
    artifacts = _build_model(request)
    validation_error = artifacts.model.validate()
    if validation_error:
        return _response(
            request,
            SolveStatus.MODEL_INVALID,
            diagnostics=[Diagnostic(code="MODEL_INVALID", message=validation_error)],
        )

    objectives: list[ObjectiveValue] = []
    final_solver: cp_model.CpSolver | None = None
    overall_optimal = True
    for name, expression in artifacts.objective_vars:
        artifacts.model.minimize(expression)
        solver = _configured_solver()
        status = solver.solve(artifacts.model)
        if status == cp_model.MODEL_INVALID:
            return _response(
                request,
                SolveStatus.MODEL_INVALID,
                diagnostics=[Diagnostic(code="MODEL_INVALID", message="CP-SAT rejected the generated model")],
            )
        if status == cp_model.INFEASIBLE:
            core = solver.sufficient_assumptions_for_infeasibility()
            names = [artifacts.assumption_names.get(index, f"literal:{index}") for index in core]
            diagnostics = [
                Diagnostic(
                    code="INFEASIBLE_CORE",
                    message="This constraint participates in a sufficient (not necessarily minimal) infeasible core.",
                    constraint=constraint,
                )
                for constraint in names
            ]
            if not diagnostics:
                diagnostics.append(
                    Diagnostic(
                        code="STRUCTURAL_INFEASIBILITY",
                        message="No solution satisfies the task effort, availability, dependency, and duration structure.",
                    )
                )
            return _response(request, SolveStatus.INFEASIBLE, diagnostics=diagnostics)
        if status == cp_model.UNKNOWN:
            return _response(
                request,
                SolveStatus.UNKNOWN,
                objectives=objectives,
                diagnostics=[Diagnostic(code="TIME_LIMIT", message="No solution was established within the fixed time limit.")],
            )

        value = int(solver.value(expression))
        bound = int(ceil(solver.best_objective_bound))
        objectives.append(ObjectiveValue(name=name, value=value, best_bound=bound))
        final_solver = solver
        if status == cp_model.FEASIBLE:
            overall_optimal = False
            break
        artifacts.model.add(expression == value)

    assert final_solver is not None
    task_plans: list[TaskPlan] = []
    commands: list[AssignmentReplaceCommand] = []
    for task in request.tasks:
        assignments = [
            PlannedAssignment(resource_id=resource.id, units_percent=final_solver.value(artifacts.units[(task.id, resource.id)]))
            for resource in request.resources
            if final_solver.value(artifacts.present[(task.id, resource.id)]) == 1
        ]
        assignments.sort(key=lambda item: item.resource_id)
        start_date = request.horizon.start_date.fromordinal(
            request.horizon.start_date.toordinal() + final_solver.value(artifacts.start[task.id])
        )
        finish_date = request.horizon.start_date.fromordinal(
            request.horizon.start_date.toordinal() + final_solver.value(artifacts.finish[task.id])
        )
        task_plans.append(
            TaskPlan(
                task_id=task.id,
                start_date=start_date,
                finish_date=finish_date,
                duration_working_days=final_solver.value(artifacts.duration[task.id]),
                assignments=assignments,
            )
        )
        commands.append(AssignmentReplaceCommand(task_id=task.id, assignments=assignments))

    task_plans.sort(key=lambda item: item.task_id)
    commands.sort(key=lambda item: item.task_id)
    capacities = {
        (resource.id, item.date): item.capacity_minutes
        for resource in request.resources
        for item in resource.availability
    }
    cost_numerator = sum(
        resource.hourly_rate_minor
        * capacities.get((resource.id, day), 0)
        * final_solver.value(artifacts.units[(task.id, resource.id)])
        * final_solver.value(artifacts.active[(task.id, _day_index(day, request))])
        for task in request.tasks
        for resource in request.resources
        for day in task.working_dates
    ) + sum(
        resource.hourly_rate_minor * item.fixed_load_scaled_minutes
        for resource in request.resources
        for item in resource.availability
    )
    overtime_scaled_value = sum(final_solver.value(value) for value in artifacts.overtime_scaled.values())
    solution = Solution(
        tasks=task_plans,
        task_durations=[
            TaskDuration(task_id=task.task_id, duration_working_days=task.duration_working_days)
            for task in task_plans
        ],
        task_starts=[TaskStart(task_id=task.task_id, start=task.start_date) for task in task_plans],
        commands=commands,
        total_cost_minor=ceil(cost_numerator / COST_DENOMINATOR),
        total_overtime_minutes=ceil(overtime_scaled_value / MINUTES_SCALE),
        selected_candidate_resource_ids=sorted(
            resource_id
            for resource_id, value in artifacts.candidate_resource_used.items()
            if final_solver.value(value) == 1
        ),
        candidate_resource_count=sum(final_solver.value(value) for value in artifacts.candidate_resource_used.values()),
        changed_assignment_pair_count=sum(final_solver.value(value) for value in artifacts.changed.values()),
        finish_date=max(task.finish_date for task in task_plans),
    )
    return _response(
        request,
        SolveStatus.OPTIMAL if overall_optimal else SolveStatus.FEASIBLE,
        solution=solution,
        objectives=objectives,
    )
