from __future__ import annotations

from copy import deepcopy
from datetime import date
import hashlib
import json
from math import sqrt

import pytest

from forecast_simulator.contracts import ForecastRequest
from forecast_simulator.simulator import NormalSource, _sample_efforts, simulate


def payload() -> dict:
    dates = [
        "2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24",
        "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31",
    ]
    value = {
        "contractVersion": "forecast.v1",
        "projectId": "project-1",
        "sourceRevision": "17",
        "completedActualCostMinor": 25000,
        "defaultWorkingDates": dates,
        "tasks": [
            {
                "id": "task-a",
                "workingDates": dates,
                "currentStartDate": dates[0],
                "dependencies": [],
                "productiveMinutesPerDay": 480,
                "weightedCostMinorPerHour": 6000,
                "actualCostMinor": 10000,
                "effortEstimate": {
                    "optimisticMinutes": 480,
                    "mostLikelyMinutes": 960,
                    "pessimisticMinutes": 1920,
                },
                "correlationGroupId": "delivery",
            },
            {
                "id": "task-b",
                "workingDates": dates,
                "currentStartDate": dates[0],
                "dependencies": [
                    {"predecessorTaskId": "task-a", "type": "FS", "lagWorkingDays": 0}
                ],
                "productiveMinutesPerDay": 480,
                "weightedCostMinorPerHour": 3000,
                "actualCostMinor": 5000,
                "effortEstimate": {
                    "optimisticMinutes": 480,
                    "mostLikelyMinutes": 960,
                    "pessimisticMinutes": 1920,
                },
                "correlationGroupId": "delivery",
            },
        ],
        "correlationGroups": [{"id": "delivery", "coefficientBasisPoints": 7000}],
        "seed": 4294967295,
        "stopping": {
            "minIterations": 1000,
            "maxIterations": 2000,
            "checkEvery": 250,
            "quantileToleranceBasisPoints": 0,
            "stableChecks": 2,
        },
        "targetFinishDate": "2026-07-27",
    }
    value["inputHash"] = hashlib.sha256(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    return value


def request_from(value: dict, *, rehash: bool = True) -> ForecastRequest:
    if rehash:
        unsigned = {key: entry for key, entry in value.items() if key != "inputHash"}
        value["inputHash"] = hashlib.sha256(
            json.dumps(unsigned, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        ).hexdigest()
    return ForecastRequest.model_validate_json(json.dumps(value))


def test_rejects_an_input_hash_that_does_not_match_the_canonical_problem() -> None:
    value = payload()
    value["inputHash"] = "b" * 64
    with pytest.raises(ValueError, match="inputHash must match"):
        request_from(value, rehash=False)


def test_same_seed_and_canonical_input_are_exactly_reproducible() -> None:
    request = request_from(payload())

    first = simulate(request).model_dump(mode="json", by_alias=True)
    second = simulate(request).model_dump(mode="json", by_alias=True)

    assert first == second
    assert first["metadata"] == {
        "algorithmVersion": "earned-signal-monte-carlo-1",
        "runtimeVersion": first["metadata"]["runtimeVersion"],
        "seed": 4294967295,
        "randomGenerator": "mt19937-box-muller-v1",
        "distributionMethod": "correlated-normal-cdf-triangular-quantile-v1",
        "scheduleMethod": "working-calendar-cpm-v1",
    }
    assert sum(item["count"] for item in first["finishHistogram"]) == first["iterations"]
    assert sum(item["count"] for item in first["costHistogram"]) == first["iterations"]
    assert [item["iteration"] for item in first["stoppingCheckpoints"]] == [1000, 1250, 1500, 1750, 2000]
    assert first["stoppingCheckpoints"][-1] == {
        "iteration": first["iterations"],
        "p50FinishDate": first["p50FinishDate"],
        "p80FinishDate": first["p80FinishDate"],
        "p50TotalCostMinor": first["p50TotalCostMinor"],
        "p80TotalCostMinor": first["p80TotalCostMinor"],
    }
    assert {
        "iterations": first["iterations"],
        "converged": first["converged"],
        "p50FinishDate": first["p50FinishDate"],
        "p80FinishDate": first["p80FinishDate"],
        "p50TotalCostMinor": first["p50TotalCostMinor"],
        "p80TotalCostMinor": first["p80TotalCostMinor"],
        "targetProbabilityBasisPoints": first["targetProbabilityBasisPoints"],
    } == {
        "iterations": 2000,
        "converged": False,
        "p50FinishDate": "2026-07-27",
        "p80FinishDate": "2026-07-28",
        "p50TotalCostMinor": 206850,
        "p80TotalCostMinor": 246000,
        "targetProbabilityBasisPoints": 7605,
    }


def test_completed_actual_cost_is_a_fixed_part_of_every_total_cost() -> None:
    with_completed = payload()
    without_completed = deepcopy(with_completed)
    without_completed["completedActualCostMinor"] = 0

    first = simulate(request_from(with_completed))
    second = simulate(request_from(without_completed))

    assert first.p50_total_cost_minor - second.p50_total_cost_minor == 25000
    assert first.p80_total_cost_minor - second.p80_total_cost_minor == 25000
    assert [item.lower_bound_minor for item in first.cost_histogram] == [
        item.lower_bound_minor + 25000 for item in second.cost_histogram
    ]
    assert [item.upper_bound_minor for item in first.cost_histogram] == [
        item.upper_bound_minor + 25000 for item in second.cost_histogram
    ]
    assert [item.count for item in first.cost_histogram] == [
        item.count for item in second.cost_histogram
    ]


def test_payload_array_order_does_not_change_random_stream_or_result() -> None:
    original = payload()
    reordered = deepcopy(original)
    reordered["tasks"].reverse()

    assert simulate(request_from(original)).model_dump(exclude={"input_hash"}) == simulate(
        request_from(reordered)
    ).model_dump(exclude={"input_hash"})


def test_high_group_coefficient_produces_positive_effort_correlation() -> None:
    request = request_from(payload())
    source = NormalSource(request.seed)
    pairs = [
        _sample_efforts(request.tasks, ["delivery"], {"delivery": 0.9}, source)
        for _ in range(2_000)
    ]
    first = [pair["task-a"] for pair in pairs]
    second = [pair["task-b"] for pair in pairs]
    first_mean = sum(first) / len(first)
    second_mean = sum(second) / len(second)
    covariance = sum(
        (left - first_mean) * (right - second_mean)
        for left, right in zip(first, second, strict=True)
    )
    first_variance = sum((value - first_mean) ** 2 for value in first)
    second_variance = sum((value - second_mean) ** 2 for value in second)

    correlation = covariance / sqrt(first_variance * second_variance)
    assert correlation > 0.75


def test_stops_after_required_consecutive_stable_checks() -> None:
    value = payload()
    value["stopping"] = {
        "minIterations": 1000,
        "maxIterations": 2000,
        "checkEvery": 500,
        "quantileToleranceBasisPoints": 10000,
        "stableChecks": 2,
    }

    result = simulate(request_from(value))

    assert result.converged is True
    assert result.iterations == 2000


def test_target_probability_matches_histogram() -> None:
    value = payload()
    result = simulate(request_from(value))
    successful = sum(
        item.count
        for item in result.finish_histogram
        if item.finish_date <= date(2026, 7, 27)
    )
    assert result.target_probability_basis_points == (
        successful * 10_000 + result.iterations // 2
    ) // result.iterations

@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda value: value.pop("completedActualCostMinor"), "Field required"),
        (lambda value: value.update(seed=-1), "greater than or equal to 0"),
        (
            lambda value: value["stopping"].update(maxIterations=50_001),
            "less than or equal to 50000",
        ),
        (lambda value: value["tasks"][0].update(unknown=True), "Extra inputs are not permitted"),
        (
            lambda value: value["tasks"][0]["effortEstimate"].update(
                optimisticMinutes=1000, mostLikelyMinutes=500
            ),
            "optimistic <= mostLikely <= pessimistic",
        ),
        (
            lambda value: value["tasks"][1].update(correlationGroupId=None),
            "each correlation group must contain at least two tasks",
        ),
        (
            lambda value: value["tasks"][0]["dependencies"].append(
                {"predecessorTaskId": "task-b", "type": "FS", "lagWorkingDays": 0}
            ),
            "dependencies must be acyclic",
        ),
        (
            lambda value: value["stopping"].update(
                minIterations=1000,
                maxIterations=2000,
                checkEvery=500,
                stableChecks=3,
            ),
            "stableChecks cannot be reached",
        ),
        (
            lambda value: value["tasks"][1]["dependencies"][0].update(lagWorkingDays=9),
            "pessimistic dependency schedule exceeds",
        ),
        (
            lambda value: value.update(completedActualCostMinor=10**15),
            "pessimistic total cost exceeds",
        ),
    ],
)
def test_contract_rejects_invalid_models(mutate, message: str) -> None:
    value = payload()
    mutate(value)
    with pytest.raises(ValueError, match=message):
        request_from(value)
