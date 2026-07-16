from __future__ import annotations

import argparse
from datetime import date, timedelta
import hashlib
import json
from time import perf_counter

from forecast_simulator.contracts import ForecastRequest
from forecast_simulator.simulator import simulate


def _working_dates(count: int) -> list[str]:
    values: list[str] = []
    current = date(2026, 1, 5)
    while len(values) < count:
        if current.weekday() < 5:
            values.append(current.isoformat())
        current += timedelta(days=1)
    return values


def _request(shape: str, iterations: int) -> ForecastRequest:
    dates = _working_dates(140)
    tasks = []
    for index in range(100):
        if shape == "chain":
            predecessor_indices = [] if index == 0 else [index - 1]
            dependency_type = "FS"
        else:
            predecessor_indices = list(range(max(0, index - 4), index))
            dependency_type = "SS"
        tasks.append(
            {
                "id": f"task-{index:03d}",
                "workingDates": dates,
                "currentStartDate": dates[0],
                "dependencies": [
                    {
                        "predecessorTaskId": f"task-{predecessor:03d}",
                        "type": dependency_type,
                        "lagWorkingDays": 0,
                    }
                    for predecessor in predecessor_indices
                ],
                "productiveMinutesPerDay": 480,
                "weightedCostMinorPerHour": 6_000,
                "actualCostMinor": 0,
                "effortEstimate": {
                    "optimisticMinutes": 480,
                    "mostLikelyMinutes": 480,
                    "pessimisticMinutes": 480,
                },
                "correlationGroupId": None,
            }
        )
    value = {
            "contractVersion": "forecast.v1",
            "projectId": f"benchmark-{shape}",
            "sourceRevision": "1",
            "completedActualCostMinor": 0,
            "defaultWorkingDates": dates,
            "tasks": tasks,
            "correlationGroups": [],
            "seed": 42,
            "stopping": {
                "minIterations": iterations - 1_000,
                "maxIterations": iterations,
                "checkEvery": 1_000,
                "quantileToleranceBasisPoints": 0,
                "stableChecks": 1,
            },
            "targetFinishDate": dates[-1],
        }
    value["inputHash"] = hashlib.sha256(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    return ForecastRequest.model_validate(value)


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark forecast.v1 at its 100-Task bound")
    parser.add_argument("--shape", choices=("chain", "dense", "both"), default="both")
    parser.add_argument("--iterations", type=int, default=50_000)
    arguments = parser.parse_args()
    if arguments.iterations < 2_000 or arguments.iterations % 1_000 != 0:
        parser.error("--iterations must be a multiple of 1000 between 2000 and 50000")
    if arguments.iterations > 50_000:
        parser.error("--iterations must be a multiple of 1000 between 2000 and 50000")

    shapes = ("chain", "dense") if arguments.shape == "both" else (arguments.shape,)
    for shape in shapes:
        request = _request(shape, arguments.iterations)
        started = perf_counter()
        response = simulate(request)
        elapsed = perf_counter() - started
        print(
            f"{shape}: tasks={len(request.tasks)} iterations={response.iterations} "
            f"elapsed={elapsed:.3f}s iterations_per_second={response.iterations / elapsed:.0f}"
        )


if __name__ == "__main__":
    main()
