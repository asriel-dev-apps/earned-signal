from __future__ import annotations

from collections import Counter
from datetime import date
from math import ceil, cos, erf, log, pi, sin, sqrt
import platform
import random

from .contracts import (
    CostHistogramBin,
    FinishHistogramBin,
    ForecastRequest,
    ForecastResponse,
    ForecastTask,
    QuantileResult,
    SimulationMetadata,
    StoppingCheckpoint,
)

ALGORITHM_VERSION = "earned-signal-monte-carlo-1"
COST_HISTOGRAM_BINS = 20


class NormalSource:
    """Versioned Box-Muller source; avoids implementation-defined gaussian caches."""

    def __init__(self, seed: int) -> None:
        self._random = random.Random(seed)
        self._spare: float | None = None

    def normal(self) -> float:
        if self._spare is not None:
            value = self._spare
            self._spare = None
            return value
        first = max(self._random.random(), 2.0**-53)
        second = self._random.random()
        radius = sqrt(-2.0 * log(first))
        angle = 2.0 * pi * second
        self._spare = radius * sin(angle)
        return radius * cos(angle)


def _normal_cdf(value: float) -> float:
    return min(1.0 - 2.0**-53, max(2.0**-53, 0.5 * (1.0 + erf(value / sqrt(2.0)))))


def _triangular_quantile(task: ForecastTask, probability: float) -> int:
    low = task.effort_estimate.optimistic_minutes
    mode = task.effort_estimate.most_likely_minutes
    high = task.effort_estimate.pessimistic_minutes
    if low == high:
        return low
    split = (mode - low) / (high - low)
    if probability < split:
        sampled = low + sqrt(probability * (high - low) * (mode - low))
    else:
        sampled = high - sqrt((1.0 - probability) * (high - low) * (high - mode))
    return min(high, max(low, round(sampled)))


def _sample_efforts(
    tasks: list[ForecastTask],
    group_ids: list[str],
    coefficients: dict[str, float],
    normal_source: NormalSource,
) -> dict[str, int]:
    group_normals = {group_id: normal_source.normal() for group_id in sorted(group_ids)}
    efforts: dict[str, int] = {}
    for task in sorted(tasks, key=lambda item: item.id):
        individual = normal_source.normal()
        if task.correlation_group_id is None:
            normal = individual
        else:
            coefficient = coefficients[task.correlation_group_id]
            normal = sqrt(coefficient) * group_normals[task.correlation_group_id] + sqrt(
                1.0 - coefficient
            ) * individual
        efforts[task.id] = _triangular_quantile(task, _normal_cdf(normal))
    return efforts


def _topological_tasks(request: ForecastRequest) -> list[ForecastTask]:
    by_id = {task.id: task for task in request.tasks}
    incoming = {task.id: len(task.dependencies) for task in request.tasks}
    successors = {task.id: [] for task in request.tasks}
    for task in request.tasks:
        for dependency in task.dependencies:
            successors[dependency.predecessor_task_id].append(task.id)
    ready = sorted(task_id for task_id, count in incoming.items() if count == 0)
    ordered: list[ForecastTask] = []
    while ready:
        task_id = ready.pop(0)
        ordered.append(by_id[task_id])
        for successor in sorted(successors[task_id]):
            incoming[successor] -= 1
            if incoming[successor] == 0:
                ready.append(successor)
                ready.sort()
    return ordered


def _working_start_indices(
    working_dates: list[date], default_working_dates: list[date]
) -> tuple[int, ...]:
    """Map every project calendar date to the first usable Task calendar index."""
    working_index = 0
    last_index = len(working_dates) - 1
    indices: list[int] = []
    for boundary in default_working_dates:
        while working_index < last_index and working_dates[working_index] < boundary:
            working_index += 1
        indices.append(working_index)
    return tuple(indices)


def _schedule_iteration(
    request: ForecastRequest,
    efforts: dict[str, int],
    ordered_tasks: list[ForecastTask],
    default_date_indices: dict[date, int],
    task_start_indices: dict[str, tuple[int, ...]],
) -> tuple[date, int]:
    scheduled: dict[str, tuple[date, date]] = {}
    total_cost = request.completed_actual_cost_minor
    for task in ordered_tasks:
        duration = ceil(efforts[task.id] / task.productive_minutes_per_day)
        earliest_start = task.current_start_date
        finish_bound: date | None = None
        for dependency in task.dependencies:
            predecessor_start, predecessor_finish = scheduled[dependency.predecessor_task_id]
            predecessor_anchor = (
                predecessor_finish if dependency.type in ("FS", "FF") else predecessor_start
            )
            offset = dependency.lag_working_days + (1 if dependency.type == "FS" else 0)
            boundary = request.default_working_dates[
                default_date_indices[predecessor_anchor] + offset
            ]
            if dependency.type in ("FS", "SS"):
                earliest_start = max(earliest_start, boundary)
            else:
                finish_bound = boundary if finish_bound is None else max(finish_bound, boundary)

        start_index = task_start_indices[task.id][default_date_indices[earliest_start]]
        if finish_bound is not None:
            while (
                start_index + duration - 1 < len(task.working_dates)
                and task.working_dates[start_index + duration - 1] < finish_bound
            ):
                start_index += 1
        finish_index = start_index + duration - 1
        scheduled[task.id] = (task.working_dates[start_index], task.working_dates[finish_index])
        labor_cost = (
            efforts[task.id] * task.weighted_cost_minor_per_hour + 59
        ) // 60
        total_cost += task.actual_cost_minor + labor_cost
    return max(finish for _, finish in scheduled.values()), total_cost


def _quantile(values: list[int], basis_points: int) -> int:
    ordered = sorted(values)
    index = ceil(basis_points * len(ordered) / 10_000) - 1
    return ordered[max(0, index)]


def _stable(current: tuple[int, int, int, int], previous: tuple[int, int, int, int], tolerance: int) -> bool:
    return all(
        abs(now - before) * 10_000 <= tolerance * max(abs(before), 1)
        for now, before in zip(current, previous, strict=True)
    )


def _cost_histogram(costs: list[int]) -> list[CostHistogramBin]:
    low, high = min(costs), max(costs)
    if low == high:
        return [CostHistogramBin(lower_bound_minor=low, upper_bound_minor=high, count=len(costs))]
    width = ceil((high - low + 1) / COST_HISTOGRAM_BINS)
    counts: Counter[int] = Counter((value - low) // width for value in costs)
    return [
        CostHistogramBin(
            lower_bound_minor=low + index * width,
            upper_bound_minor=min(high, low + (index + 1) * width - 1),
            count=counts[index],
        )
        for index in sorted(counts)
    ]


def simulate(request: ForecastRequest) -> ForecastResponse:
    normal_source = NormalSource(request.seed)
    coefficients = {
        group.id: group.coefficient_basis_points / 10_000
        for group in request.correlation_groups
    }
    finish_ordinals: list[int] = []
    costs: list[int] = []
    previous_checkpoint: tuple[int, int, int, int] | None = None
    ordered_tasks = _topological_tasks(request)
    default_date_indices = {
        value: index for index, value in enumerate(request.default_working_dates)
    }
    task_start_indices = {
        task.id: _working_start_indices(task.working_dates, request.default_working_dates)
        for task in request.tasks
    }
    stable_count = 0
    converged = False
    stopping_checkpoints: list[StoppingCheckpoint] = []

    for iteration in range(1, request.stopping.max_iterations + 1):
        efforts = _sample_efforts(
            request.tasks,
            [group.id for group in request.correlation_groups],
            coefficients,
            normal_source,
        )
        finish, cost = _schedule_iteration(
            request,
            efforts,
            ordered_tasks,
            default_date_indices,
            task_start_indices,
        )
        finish_ordinals.append(finish.toordinal())
        costs.append(cost)

        should_check = iteration >= request.stopping.min_iterations and (
            iteration == request.stopping.max_iterations
            or (iteration - request.stopping.min_iterations) % request.stopping.check_every == 0
        )
        if not should_check:
            continue
        p50_finish_ordinal = _quantile(finish_ordinals, 5_000)
        p80_finish_ordinal = _quantile(finish_ordinals, 8_000)
        p50_cost_checkpoint = _quantile(costs, 5_000)
        p80_cost_checkpoint = _quantile(costs, 8_000)
        checkpoint = (
            default_date_indices[date.fromordinal(p50_finish_ordinal)],
            default_date_indices[date.fromordinal(p80_finish_ordinal)],
            p50_cost_checkpoint,
            p80_cost_checkpoint,
        )
        stopping_checkpoints.append(StoppingCheckpoint(
            iteration=iteration,
            p50_finish_date=date.fromordinal(p50_finish_ordinal),
            p80_finish_date=date.fromordinal(p80_finish_ordinal),
            p50_total_cost_minor=p50_cost_checkpoint,
            p80_total_cost_minor=p80_cost_checkpoint,
        ))
        if previous_checkpoint is not None and _stable(
            checkpoint,
            previous_checkpoint,
            request.stopping.quantile_tolerance_basis_points,
        ):
            stable_count += 1
        else:
            stable_count = 0
        previous_checkpoint = checkpoint
        if stable_count >= request.stopping.stable_checks:
            converged = True
            break

    iterations = len(costs)
    p50_finish = date.fromordinal(_quantile(finish_ordinals, 5_000))
    p80_finish = date.fromordinal(_quantile(finish_ordinals, 8_000))
    p50_cost = _quantile(costs, 5_000)
    p80_cost = _quantile(costs, 8_000)
    successes = sum(value <= request.target_finish_date.toordinal() for value in finish_ordinals)
    target_probability = (successes * 10_000 + iterations // 2) // iterations

    finish_counts = Counter(finish_ordinals)
    return ForecastResponse(
        input_hash=request.input_hash,
        project_id=request.project_id,
        source_revision=request.source_revision,
        iterations=iterations,
        converged=converged,
        p50_finish_date=p50_finish,
        p80_finish_date=p80_finish,
        p50_total_cost_minor=p50_cost,
        p80_total_cost_minor=p80_cost,
        target_probability_basis_points=target_probability,
        stopping_checkpoints=stopping_checkpoints,
        quantiles=[
            QuantileResult(basis_points=5_000, finish_date=p50_finish, total_cost_minor=p50_cost),
            QuantileResult(basis_points=8_000, finish_date=p80_finish, total_cost_minor=p80_cost),
        ],
        finish_histogram=[
            FinishHistogramBin(finish_date=date.fromordinal(value), count=finish_counts[value])
            for value in sorted(finish_counts)
        ],
        cost_histogram=_cost_histogram(costs),
        metadata=SimulationMetadata(
            algorithm_version=ALGORITHM_VERSION,
            runtime_version=platform.python_version(),
            seed=request.seed,
            random_generator="mt19937-box-muller-v1",
            distribution_method="correlated-normal-cdf-triangular-quantile-v1",
            schedule_method="working-calendar-cpm-v1",
        ),
    )
