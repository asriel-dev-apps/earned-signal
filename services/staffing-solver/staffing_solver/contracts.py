from __future__ import annotations

from datetime import date
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda value: "".join(
            word if index == 0 else word.capitalize()
            for index, word in enumerate(value.split("_"))
        ),
        populate_by_name=True,
        extra="forbid",
        strict=True,
    )


Identifier = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")]
PositiveMinutes = Annotated[int, Field(ge=1, le=10_000_000)]


class Horizon(ContractModel):
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def validate_range(self) -> Horizon:
        days = (self.end_date - self.start_date).days + 1
        if days < 1 or days > 366:
            raise ValueError("horizon must contain between 1 and 366 calendar days")
        return self


class Dependency(ContractModel):
    predecessor_task_id: Identifier
    type: Literal["FS", "SS", "FF", "SF"] = "FS"
    lag_working_days: Annotated[int, Field(ge=0, le=365)] = 0


class TaskConstraint(ContractModel):
    type: Literal[
        "START_NO_EARLIER_THAN",
        "FINISH_NO_LATER_THAN",
        "MUST_START_ON",
        "MUST_FINISH_ON",
    ]
    date: date


class FixedTask(ContractModel):
    id: Identifier
    start_date: date
    finish_date: date

    @model_validator(mode="after")
    def validate_schedule(self) -> FixedTask:
        if self.finish_date < self.start_date:
            raise ValueError("fixed Task finishDate must not precede startDate")
        return self


class Task(ContractModel):
    id: Identifier
    remaining_effort_minutes: PositiveMinutes
    required_skills: list[Identifier] = Field(default_factory=list, max_length=64)
    working_dates: list[date] = Field(min_length=1, max_length=366)
    current_start_date: date
    current_duration_working_days: Annotated[int, Field(ge=1, le=366)]
    min_duration_working_days: Annotated[int, Field(ge=1, le=366)] = 1
    max_duration_working_days: Annotated[int, Field(ge=1, le=366)]
    max_parallel_resources: Annotated[int, Field(ge=1, le=100)] = 10
    dependencies: list[Dependency] = Field(default_factory=list, max_length=100)
    constraint: TaskConstraint | None = None

    @model_validator(mode="after")
    def validate_task(self) -> Task:
        if len(self.working_dates) != len(set(self.working_dates)):
            raise ValueError("workingDates must not contain duplicates")
        if self.working_dates != sorted(self.working_dates):
            raise ValueError("workingDates must be sorted")
        if self.min_duration_working_days > self.max_duration_working_days:
            raise ValueError("minDurationWorkingDays must not exceed maxDurationWorkingDays")
        if self.max_duration_working_days > len(self.working_dates):
            raise ValueError("maxDurationWorkingDays must not exceed the number of workingDates")
        if self.current_start_date not in self.working_dates:
            raise ValueError("currentStartDate must be one of the task workingDates")
        if len(self.required_skills) != len(set(self.required_skills)):
            raise ValueError("requiredSkills must not contain duplicates")
        return self


class Availability(ContractModel):
    date: date
    capacity_minutes: Annotated[int, Field(ge=0, le=1_440)]
    fixed_load_scaled_minutes: Annotated[int, Field(ge=0, le=1_000_000_000)] = 0


class Resource(ContractModel):
    id: Identifier
    is_candidate: bool
    hourly_rate_minor: Annotated[int, Field(ge=0, le=100_000_000)]
    skills: list[Identifier] = Field(default_factory=list, max_length=256)
    availability: list[Availability] = Field(min_length=1, max_length=366)

    @model_validator(mode="after")
    def validate_resource(self) -> Resource:
        dates = [item.date for item in self.availability]
        if len(dates) != len(set(dates)):
            raise ValueError("availability dates must not contain duplicates")
        if dates != sorted(dates):
            raise ValueError("availability must be sorted by date")
        if len(self.skills) != len(set(self.skills)):
            raise ValueError("skills must not contain duplicates")
        return self


class CurrentAssignment(ContractModel):
    task_id: Identifier
    resource_id: Identifier
    units_percent: Annotated[int, Field(ge=1, le=100)]


class HardConstraints(ContractModel):
    deadline: date | None = None
    max_cost_minor: Annotated[int | None, Field(ge=0, le=10**15)] = None
    max_total_overtime_minutes: Annotated[int | None, Field(ge=0, le=10_000_000)] = None
    max_changed_assignment_pairs: Annotated[int | None, Field(ge=0, le=10_000)] = None
    max_schedule_changes: Annotated[int | None, Field(ge=0, le=100)] = None
    max_candidate_resources: Annotated[int | None, Field(ge=0, le=10_000)] = None


class Objective(ContractModel):
    priorities: list[
        Literal["MINIMIZE_FINISH", "MINIMIZE_COST", "MINIMIZE_OVERTIME", "MINIMIZE_CHANGE"]
    ] = Field(min_length=1, max_length=4)

    @model_validator(mode="after")
    def validate_priorities(self) -> Objective:
        if self.priorities != [
            "MINIMIZE_FINISH", "MINIMIZE_OVERTIME", "MINIMIZE_COST", "MINIMIZE_CHANGE"
        ]:
            raise ValueError("objective priorities must use the fixed verified order")
        return self


class SolveRequest(ContractModel):
    contract_version: Literal["staffing.v1"]
    request_id: Identifier
    horizon: Horizon
    default_working_dates: list[date] = Field(min_length=1, max_length=366)
    fixed_tasks: list[FixedTask] = Field(default_factory=list, max_length=10_000)
    tasks: list[Task] = Field(min_length=1, max_length=100)
    resources: list[Resource] = Field(min_length=1, max_length=100)
    current_assignments: list[CurrentAssignment] = Field(default_factory=list, max_length=10_000)
    allowed_units_percent: list[Annotated[int, Field(ge=1, le=100)]] = Field(
        default_factory=lambda: [25, 50, 75, 100], min_length=1, max_length=100
    )
    constraints: HardConstraints
    objective: Objective

    @model_validator(mode="after")
    def validate_references(self) -> SolveRequest:
        task_ids = [task.id for task in self.tasks]
        fixed_task_ids = [task.id for task in self.fixed_tasks]
        resource_ids = [resource.id for resource in self.resources]
        if len(task_ids) != len(set(task_ids)):
            raise ValueError("task ids must be unique")
        if len(fixed_task_ids) != len(set(fixed_task_ids)):
            raise ValueError("fixed Task ids must be unique")
        if set(task_ids) & set(fixed_task_ids):
            raise ValueError("fixed and optimizable Task ids must be disjoint")
        if len(resource_ids) != len(set(resource_ids)):
            raise ValueError("resource ids must be unique")
        if len(self.allowed_units_percent) != len(set(self.allowed_units_percent)):
            raise ValueError("allowedUnitsPercent must not contain duplicates")
        if self.allowed_units_percent != sorted(self.allowed_units_percent):
            raise ValueError("allowedUnitsPercent must be sorted")

        task_id_set = set(task_ids)
        known_task_ids = task_id_set | set(fixed_task_ids)
        resource_id_set = set(resource_ids)
        horizon_dates = {
            self.horizon.start_date.fromordinal(ordinal)
            for ordinal in range(self.horizon.start_date.toordinal(), self.horizon.end_date.toordinal() + 1)
        }
        if len(self.default_working_dates) != len(set(self.default_working_dates)):
            raise ValueError("defaultWorkingDates must not contain duplicates")
        if self.default_working_dates != sorted(self.default_working_dates):
            raise ValueError("defaultWorkingDates must be sorted")
        if not set(self.default_working_dates).issubset(horizon_dates):
            raise ValueError("defaultWorkingDates must be within the horizon")
        for task in self.fixed_tasks:
            if task.start_date not in horizon_dates or task.finish_date not in horizon_dates:
                raise ValueError(f"fixed Task {task.id} schedule must be within the horizon")
        for task in self.tasks:
            if not set(task.working_dates).issubset(horizon_dates):
                raise ValueError(f"task {task.id} has workingDates outside the horizon")
            for dependency in task.dependencies:
                if dependency.predecessor_task_id not in known_task_ids:
                    raise ValueError(f"task {task.id} references an unknown predecessor")
                if dependency.predecessor_task_id == task.id:
                    raise ValueError(f"task {task.id} cannot depend on itself")
            if task.constraint is not None and task.constraint.date not in horizon_dates:
                raise ValueError(f"task {task.id} has a constraint date outside the horizon")
        for resource in self.resources:
            if not set(item.date for item in resource.availability).issubset(horizon_dates):
                raise ValueError(f"resource {resource.id} has availability outside the horizon")

        assignment_keys: set[tuple[str, str]] = set()
        allowed = set(self.allowed_units_percent)
        for assignment in self.current_assignments:
            if assignment.task_id not in task_id_set or assignment.resource_id not in resource_id_set:
                raise ValueError("currentAssignments contains an unknown task or resource")
            key = (assignment.task_id, assignment.resource_id)
            if key in assignment_keys:
                raise ValueError("currentAssignments must contain unique task/resource pairs")
            assignment_keys.add(key)
            if assignment.units_percent not in allowed:
                raise ValueError("current assignment unitsPercent must be in allowedUnitsPercent")

        if self.constraints.deadline is not None and self.constraints.deadline not in horizon_dates:
            raise ValueError("deadline must be within the horizon")
        return self


class SolveStatus(StrEnum):
    OPTIMAL = "OPTIMAL"
    FEASIBLE = "FEASIBLE"
    INFEASIBLE = "INFEASIBLE"
    UNKNOWN = "UNKNOWN"
    MODEL_INVALID = "MODEL_INVALID"


class PlannedAssignment(ContractModel):
    resource_id: Identifier
    units_percent: int


class AssignmentReplaceCommand(ContractModel):
    type: Literal["assignment.replace"] = "assignment.replace"
    task_id: Identifier
    assignments: list[PlannedAssignment]


class TaskPlan(ContractModel):
    task_id: Identifier
    start_date: date
    finish_date: date
    duration_working_days: int
    assignments: list[PlannedAssignment]


class TaskDuration(ContractModel):
    task_id: Identifier
    duration_working_days: int


class TaskStart(ContractModel):
    task_id: Identifier
    start: date


class Solution(ContractModel):
    tasks: list[TaskPlan]
    task_durations: list[TaskDuration]
    task_starts: list[TaskStart]
    commands: list[AssignmentReplaceCommand]
    total_cost_minor: int
    total_overtime_minutes: int
    selected_candidate_resource_ids: list[Identifier]
    candidate_resource_count: int
    changed_assignment_pair_count: int
    finish_date: date


class ObjectiveValue(ContractModel):
    name: Identifier
    value: int
    best_bound: int


class Diagnostic(ContractModel):
    code: Identifier
    message: str
    constraint: str | None = None


class SolveResponse(ContractModel):
    contract_version: Literal["staffing.v1"] = "staffing.v1"
    request_id: Identifier
    status: SolveStatus
    solution: Solution | None = None
    objectives: list[ObjectiveValue] = Field(default_factory=list)
    diagnostics: list[Diagnostic] = Field(default_factory=list)
    solver_version: str
    deterministic_seed: int
    workers: int
    time_limit_seconds_per_stage: int
    deterministic_time_limit_per_stage: float
