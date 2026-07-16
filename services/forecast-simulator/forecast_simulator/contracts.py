from __future__ import annotations

from datetime import date
import hashlib
import json
from math import ceil
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator


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
Revision = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^\d+$")]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Money = Annotated[int, Field(ge=0, le=10**15)]


def _parse_contract_date(value: object) -> object:
    if type(value) is not str:
        return value
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return value
    return parsed if parsed.isoformat() == value else value


ContractDate = Annotated[date, BeforeValidator(_parse_contract_date)]


class Dependency(ContractModel):
    predecessor_task_id: Identifier
    type: Literal["FS", "SS", "FF", "SF"] = "FS"
    lag_working_days: Annotated[int, Field(ge=0, le=365)] = 0


class TriangularEffortEstimate(ContractModel):
    optimistic_minutes: Annotated[int, Field(ge=1, le=10_000_000)]
    most_likely_minutes: Annotated[int, Field(ge=1, le=10_000_000)]
    pessimistic_minutes: Annotated[int, Field(ge=1, le=10_000_000)]

    @model_validator(mode="after")
    def validate_order(self) -> TriangularEffortEstimate:
        if not self.optimistic_minutes <= self.most_likely_minutes <= self.pessimistic_minutes:
            raise ValueError("effort estimates must satisfy optimistic <= mostLikely <= pessimistic")
        return self


class ForecastTask(ContractModel):
    id: Identifier
    working_dates: list[ContractDate] = Field(min_length=1, max_length=366)
    current_start_date: ContractDate
    dependencies: list[Dependency] = Field(default_factory=list, max_length=100)
    productive_minutes_per_day: Annotated[int, Field(ge=1, le=144_000)]
    weighted_cost_minor_per_hour: Annotated[int, Field(ge=0, le=100_000_000)]
    actual_cost_minor: Money
    effort_estimate: TriangularEffortEstimate
    correlation_group_id: Identifier | None = None

    @model_validator(mode="after")
    def validate_calendar(self) -> ForecastTask:
        if self.working_dates != sorted(self.working_dates):
            raise ValueError("workingDates must be sorted")
        if len(self.working_dates) != len(set(self.working_dates)):
            raise ValueError("workingDates must not contain duplicates")
        if self.current_start_date not in self.working_dates:
            raise ValueError("currentStartDate must be one of workingDates")
        capacity = self.productive_minutes_per_day * len(self.working_dates)
        if self.effort_estimate.pessimistic_minutes > capacity:
            raise ValueError("pessimistic effort must fit within workingDates")
        return self


class CorrelationGroup(ContractModel):
    id: Identifier
    coefficient_basis_points: Annotated[int, Field(ge=0, le=9_500)]


class StoppingRule(ContractModel):
    min_iterations: Annotated[int, Field(ge=1_000, le=50_000)]
    max_iterations: Annotated[int, Field(ge=1_000, le=50_000)]
    check_every: Annotated[int, Field(ge=100, le=5_000)]
    quantile_tolerance_basis_points: Annotated[int, Field(ge=0, le=10_000)]
    stable_checks: Annotated[int, Field(ge=1, le=100)]

    @model_validator(mode="after")
    def validate_stopping(self) -> StoppingRule:
        if self.min_iterations > self.max_iterations:
            raise ValueError("minIterations must not exceed maxIterations")
        if self.check_every > self.max_iterations:
            raise ValueError("checkEvery must not exceed maxIterations")
        if self.min_iterations % self.check_every != 0:
            raise ValueError("minIterations must be a multiple of checkEvery")
        if self.max_iterations % self.check_every != 0:
            raise ValueError("maxIterations must be a multiple of checkEvery")
        available_comparisons = (self.max_iterations - self.min_iterations) // self.check_every
        if self.stable_checks > available_comparisons:
            raise ValueError("stableChecks cannot be reached before maxIterations")
        return self


class ForecastRequest(ContractModel):
    contract_version: Literal["forecast.v1"]
    input_hash: Sha256
    project_id: Identifier
    source_revision: Revision
    completed_actual_cost_minor: Money
    default_working_dates: list[ContractDate] = Field(min_length=1, max_length=366)
    tasks: list[ForecastTask] = Field(min_length=1, max_length=100)
    correlation_groups: list[CorrelationGroup] = Field(default_factory=list, max_length=25)
    seed: Annotated[int, Field(ge=0, le=4_294_967_295)]
    stopping: StoppingRule
    target_finish_date: ContractDate

    @model_validator(mode="after")
    def validate_model(self) -> ForecastRequest:
        canonical_input = json.dumps(
            self.model_dump(mode="json", by_alias=True, exclude={"input_hash"}),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        if hashlib.sha256(canonical_input).hexdigest() != self.input_hash:
            raise ValueError("inputHash must match the canonical Forecast input")
        if self.default_working_dates != sorted(self.default_working_dates):
            raise ValueError("defaultWorkingDates must be sorted")
        if len(self.default_working_dates) != len(set(self.default_working_dates)):
            raise ValueError("defaultWorkingDates must not contain duplicates")
        default_dates = set(self.default_working_dates)
        task_ids = [task.id for task in self.tasks]
        if len(task_ids) != len(set(task_ids)):
            raise ValueError("task ids must be unique")
        group_ids = [group.id for group in self.correlation_groups]
        if len(group_ids) != len(set(group_ids)):
            raise ValueError("correlation group ids must be unique")
        known_tasks = set(task_ids)
        known_groups = set(group_ids)
        group_members = {group_id: 0 for group_id in group_ids}
        for task in self.tasks:
            if not set(task.working_dates).issubset(default_dates):
                raise ValueError(f"task {task.id} has workingDates outside defaultWorkingDates")
            if task.correlation_group_id is not None and task.correlation_group_id not in known_groups:
                raise ValueError(f"task {task.id} references an unknown correlation group")
            if task.correlation_group_id is not None:
                group_members[task.correlation_group_id] += 1
            seen_predecessors: set[str] = set()
            for dependency in task.dependencies:
                if dependency.predecessor_task_id not in known_tasks:
                    raise ValueError(f"task {task.id} references an unknown predecessor")
                if dependency.predecessor_task_id == task.id:
                    raise ValueError(f"task {task.id} cannot depend on itself")
                if dependency.predecessor_task_id in seen_predecessors:
                    raise ValueError(f"task {task.id} has duplicate predecessor dependencies")
                seen_predecessors.add(dependency.predecessor_task_id)
        if any(member_count < 2 for member_count in group_members.values()):
            raise ValueError("each correlation group must contain at least two tasks")
        pessimistic_total_cost = self.completed_actual_cost_minor + sum(
            task.actual_cost_minor
            + (
                task.effort_estimate.pessimistic_minutes
                * task.weighted_cost_minor_per_hour
                + 59
            )
            // 60
            for task in self.tasks
        )
        if pessimistic_total_cost > 10**15:
            raise ValueError("pessimistic total cost exceeds the forecast.v1 transport limit")

        incoming = {task_id: 0 for task_id in task_ids}
        successors = {task_id: [] for task_id in task_ids}
        for task in self.tasks:
            for dependency in task.dependencies:
                incoming[task.id] += 1
                successors[dependency.predecessor_task_id].append(task.id)
        ready = sorted(task_id for task_id, count in incoming.items() if count == 0)
        ordered_task_ids: list[str] = []
        visited = 0
        while ready:
            task_id = ready.pop(0)
            ordered_task_ids.append(task_id)
            visited += 1
            for successor in sorted(successors[task_id]):
                incoming[successor] -= 1
                if incoming[successor] == 0:
                    ready.append(successor)
                    ready.sort()
        if visited != len(task_ids):
            raise ValueError("task dependencies must be acyclic")

        by_id = {task.id: task for task in self.tasks}
        default_index = {value: index for index, value in enumerate(self.default_working_dates)}
        pessimistic_schedule: dict[str, tuple[date, date]] = {}
        for task_id in ordered_task_ids:
            task = by_id[task_id]
            duration = ceil(
                task.effort_estimate.pessimistic_minutes / task.productive_minutes_per_day
            )
            earliest_start = task.current_start_date
            finish_boundary: date | None = None
            for dependency in task.dependencies:
                predecessor_start, predecessor_finish = pessimistic_schedule[
                    dependency.predecessor_task_id
                ]
                anchor = (
                    predecessor_finish if dependency.type in ("FS", "FF") else predecessor_start
                )
                offset = dependency.lag_working_days + (1 if dependency.type == "FS" else 0)
                target_index = default_index[anchor] + offset
                if target_index >= len(self.default_working_dates):
                    raise ValueError("pessimistic dependency schedule exceeds defaultWorkingDates")
                boundary = self.default_working_dates[target_index]
                if dependency.type in ("FS", "SS"):
                    earliest_start = max(earliest_start, boundary)
                else:
                    finish_boundary = (
                        boundary if finish_boundary is None else max(finish_boundary, boundary)
                    )
            eligible_starts = [
                index for index, value in enumerate(task.working_dates) if value >= earliest_start
            ]
            if not eligible_starts:
                raise ValueError("pessimistic Task schedule exceeds workingDates")
            start_index = eligible_starts[0]
            if finish_boundary is not None:
                while (
                    start_index + duration - 1 < len(task.working_dates)
                    and task.working_dates[start_index + duration - 1] < finish_boundary
                ):
                    start_index += 1
            finish_index = start_index + duration - 1
            if finish_index >= len(task.working_dates):
                raise ValueError("pessimistic Task schedule exceeds workingDates")
            pessimistic_schedule[task.id] = (
                task.working_dates[start_index], task.working_dates[finish_index]
            )
        return self


class QuantileResult(ContractModel):
    basis_points: Literal[5000, 8000]
    finish_date: ContractDate
    total_cost_minor: Money


class FinishHistogramBin(ContractModel):
    finish_date: ContractDate
    count: int


class CostHistogramBin(ContractModel):
    lower_bound_minor: Money
    upper_bound_minor: Money
    count: int


class SimulationMetadata(ContractModel):
    algorithm_version: Literal["earned-signal-monte-carlo-1"]
    runtime_version: str
    seed: int
    random_generator: Literal["mt19937-box-muller-v1"]
    distribution_method: Literal["correlated-normal-cdf-triangular-quantile-v1"]
    schedule_method: Literal["working-calendar-cpm-v1"]


class StoppingCheckpoint(ContractModel):
    iteration: Annotated[int, Field(ge=1_000, le=50_000)]
    p50_finish_date: ContractDate
    p80_finish_date: ContractDate
    p50_total_cost_minor: Money
    p80_total_cost_minor: Money


class ForecastResponse(ContractModel):
    contract_version: Literal["forecast.v1"] = "forecast.v1"
    input_hash: Sha256
    project_id: Identifier
    source_revision: Revision
    iterations: int
    converged: bool
    p50_finish_date: ContractDate
    p80_finish_date: ContractDate
    p50_total_cost_minor: Money
    p80_total_cost_minor: Money
    target_probability_basis_points: Annotated[int, Field(ge=0, le=10_000)]
    stopping_checkpoints: list[StoppingCheckpoint] = Field(min_length=1, max_length=491)
    quantiles: list[QuantileResult]
    finish_histogram: list[FinishHistogramBin]
    cost_histogram: list[CostHistogramBin]
    metadata: SimulationMetadata
