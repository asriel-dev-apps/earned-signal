from datetime import date
import json
import pytest

from staffing_solver.contracts import SolveRequest, SolveStatus
from staffing_solver.solver import solve


def request_from(payload: dict) -> SolveRequest:
    return SolveRequest.model_validate_json(json.dumps(payload))


def base_payload() -> dict:
    dates = ["2026-07-20", "2026-07-21", "2026-07-22"]
    return {
        "contractVersion": "staffing.v1",
        "requestId": "golden-1",
        "horizon": {"startDate": dates[0], "endDate": dates[-1]},
        "defaultWorkingDates": dates,
        "tasks": [
            {
                "id": "task-a",
                "remainingEffortMinutes": 960,
                "requiredSkills": ["python"],
                "workingDates": dates,
                "currentStartDate": dates[0],
                "currentDurationWorkingDays": 3,
                "minDurationWorkingDays": 1,
                "maxDurationWorkingDays": 3,
                "maxParallelResources": 2,
                "dependencies": [],
            }
        ],
        "resources": [
            {
                "id": "alice",
                "isCandidate": False,
                "hourlyRateMinor": 6000,
                "skills": ["python"],
                "availability": [{"date": value, "capacityMinutes": 480} for value in dates],
            },
            {
                "id": "bob",
                "isCandidate": True,
                "hourlyRateMinor": 3000,
                "skills": ["python"],
                "availability": [{"date": value, "capacityMinutes": 480} for value in dates],
            },
        ],
        "currentAssignments": [{"taskId": "task-a", "resourceId": "alice", "unitsPercent": 100}],
        "allowedUnitsPercent": [50, 100],
        "constraints": {
            "deadline": "2026-07-22",
            "maxCostMinor": 200000,
            "maxTotalOvertimeMinutes": 0,
            "maxChangedAssignmentPairs": 1,
            "maxScheduleChanges": 1,
            "maxCandidateResources": 1,
        },
        "objective": {
            "priorities": ["MINIMIZE_FINISH", "MINIMIZE_OVERTIME", "MINIMIZE_COST", "MINIMIZE_CHANGE"]
        },
    }


def test_golden_finish_first_selects_candidate_and_one_day() -> None:
    response = solve(request_from(base_payload()))

    assert response.status == SolveStatus.OPTIMAL
    assert response.solution is not None
    assert response.solution.tasks[0].duration_working_days == 1
    assert response.solution.tasks[0].start_date == date(2026, 7, 20)
    assert response.solution.tasks[0].finish_date == date(2026, 7, 20)
    assert response.solution.commands[0].model_dump(by_alias=True) == {
        "type": "assignment.replace",
        "taskId": "task-a",
        "assignments": [
            {"resourceId": "alice", "unitsPercent": 100},
            {"resourceId": "bob", "unitsPercent": 100},
        ],
    }
    assert response.solution.candidate_resource_count == 1
    assert response.solution.selected_candidate_resource_ids == ["bob"]
    assert response.solution.task_durations[0].model_dump(by_alias=True) == {
        "taskId": "task-a",
        "durationWorkingDays": 1,
    }
    assert response.solution.task_starts[0].model_dump(by_alias=True) == {
        "taskId": "task-a",
        "start": date(2026, 7, 20),
    }
    assert response.solution.changed_assignment_pair_count == 1
    assert response.solution.total_cost_minor == 72000
    assert [item.name for item in response.objectives] == [
        "finishDayIndex",
        "overtimeScaledMinutes",
        "costNumerator",
        "changedAssignmentPairCount",
        "scheduleChangeCount",
        "candidateResourceCount",
        "stableAssignmentScore",
        "stableStartScore",
    ]
    assert all(item.value == item.best_bound for item in response.objectives)


def test_completed_task_load_is_fixed_in_overtime_and_cost() -> None:
    payload = base_payload()
    payload["resources"][0]["availability"][0]["fixedLoadScaledMinutes"] = 24_000

    response = solve(request_from(payload))

    assert response.status == SolveStatus.OPTIMAL
    assert response.solution is not None
    assert response.solution.tasks[0].start_date == date(2026, 7, 21)
    assert response.solution.tasks[0].finish_date == date(2026, 7, 21)
    assert response.solution.total_overtime_minutes == 0
    assert response.solution.total_cost_minor == 96_000


def test_completed_predecessor_sets_a_fixed_fs_boundary() -> None:
    payload = base_payload()
    payload["fixedTasks"] = [
        {"id": "task-done", "startDate": "2026-07-20", "finishDate": "2026-07-20"}
    ]
    payload["tasks"][0]["dependencies"] = [
        {"predecessorTaskId": "task-done", "type": "FS", "lagWorkingDays": 0}
    ]

    response = solve(request_from(payload))

    assert response.status == SolveStatus.OPTIMAL
    assert response.solution is not None
    assert response.solution.tasks[0].start_date == date(2026, 7, 21)


def test_deadline_and_overtime_assumptions_are_reported_for_infeasible_request() -> None:
    payload = base_payload()
    payload["constraints"]["deadline"] = "2026-07-20"
    payload["constraints"]["maxCandidateResources"] = 0

    response = solve(request_from(payload))

    assert response.status == SolveStatus.INFEASIBLE
    constraints = {item.constraint for item in response.diagnostics}
    assert "deadline" in constraints
    assert "candidateResources" in constraints or "overtimePerResourceDay" in constraints


def test_skill_assumption_is_reported() -> None:
    payload = base_payload()
    payload["tasks"][0]["requiredSkills"] = ["rust"]

    response = solve(request_from(payload))

    assert response.status == SolveStatus.INFEASIBLE
    assert "skill:task-a:rust" in {item.constraint for item in response.diagnostics}


def test_dependency_uses_default_calendar_working_day_lag() -> None:
    payload = base_payload()
    dates = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"]
    payload["horizon"]["endDate"] = dates[-1]
    payload["defaultWorkingDates"] = dates
    payload["resources"][0]["availability"].append({"date": dates[-1], "capacityMinutes": 480})
    payload["resources"][1]["availability"].append({"date": dates[-1], "capacityMinutes": 480})
    payload["tasks"][0]["remainingEffortMinutes"] = 480
    payload["tasks"][0]["workingDates"] = dates
    payload["tasks"][0]["maxDurationWorkingDays"] = 4
    payload["tasks"].append(
        {
            "id": "task-b",
            "remainingEffortMinutes": 480,
            "requiredSkills": ["python"],
            "workingDates": dates,
            "currentStartDate": dates[0],
            "currentDurationWorkingDays": 1,
            "minDurationWorkingDays": 1,
            "maxDurationWorkingDays": 1,
            "maxParallelResources": 1,
            "dependencies": [{"predecessorTaskId": "task-a", "type": "FS", "lagWorkingDays": 1}],
        }
    )
    payload["currentAssignments"].append({"taskId": "task-b", "resourceId": "alice", "unitsPercent": 100})
    payload["constraints"]["deadline"] = dates[-1]
    payload["constraints"]["maxChangedAssignmentPairs"] = 2
    payload["constraints"]["maxScheduleChanges"] = 2

    response = solve(request_from(payload))

    assert response.status == SolveStatus.OPTIMAL
    assert response.solution is not None
    plans = {task.task_id: task for task in response.solution.tasks}
    assert (plans["task-b"].start_date - plans["task-a"].finish_date).days == 2


def dependency_payload(kind: str, lag: int = 0) -> dict:
    payload = base_payload()
    dates = ["2026-07-17", "2026-07-20", "2026-07-21", "2026-07-22"]
    payload["horizon"] = {"startDate": dates[0], "endDate": dates[-1]}
    payload["defaultWorkingDates"] = dates
    for resource in payload["resources"]:
        resource["availability"] = [{"date": value, "capacityMinutes": 480} for value in dates]
    payload["tasks"][0].update(
        remainingEffortMinutes=480,
        workingDates=dates,
        currentStartDate=dates[0],
        currentDurationWorkingDays=1,
        maxDurationWorkingDays=1,
    )
    payload["tasks"].append(
        {
            "id": "task-b",
            "remainingEffortMinutes": 480,
            "requiredSkills": ["python"],
            "workingDates": dates,
            "currentStartDate": dates[0],
            "currentDurationWorkingDays": 1,
            "minDurationWorkingDays": 1,
            "maxDurationWorkingDays": 1,
            "maxParallelResources": 1,
            "dependencies": [{"predecessorTaskId": "task-a", "type": kind, "lagWorkingDays": lag}],
            "constraint": None,
        }
    )
    payload["currentAssignments"].append({"taskId": "task-b", "resourceId": "alice", "unitsPercent": 100})
    payload["constraints"].update(
        deadline=dates[-1], maxChangedAssignmentPairs=2, maxScheduleChanges=2
    )
    return payload


def test_fs_lag_advances_over_weekend_on_default_calendar() -> None:
    payload = dependency_payload("FS", lag=0)
    # Friday + one default working day is Monday, never Saturday.
    payload["tasks"][0]["constraint"] = {"type": "MUST_START_ON", "date": "2026-07-17"}

    response = solve(request_from(payload))

    assert response.status == SolveStatus.OPTIMAL
    assert response.solution is not None
    plans = {task.task_id: task for task in response.solution.tasks}
    assert plans["task-b"].start_date == date(2026, 7, 20)


def test_all_dependency_types_use_the_correct_endpoints() -> None:
    expected = {
        "FS": (date(2026, 7, 17), date(2026, 7, 20)),
        "SS": (date(2026, 7, 17), date(2026, 7, 17)),
        "FF": (date(2026, 7, 17), date(2026, 7, 17)),
        "SF": (date(2026, 7, 17), date(2026, 7, 17)),
    }
    for kind, (predecessor_finish, successor_anchor) in expected.items():
        response = solve(request_from(dependency_payload(kind)))
        assert response.status == SolveStatus.OPTIMAL
        assert response.solution is not None
        plans = {task.task_id: task for task in response.solution.tasks}
        assert plans["task-a"].finish_date == predecessor_finish
        endpoint = plans["task-b"].start_date if kind in ("FS", "SS") else plans["task-b"].finish_date
        assert endpoint == successor_anchor


def test_task_constraints_restrict_selected_patterns() -> None:
    constraint_cases = {
        "START_NO_EARLIER_THAN": ("2026-07-21", "start_date"),
        "FINISH_NO_LATER_THAN": ("2026-07-21", "finish_date"),
        "MUST_START_ON": ("2026-07-21", "start_date"),
        "MUST_FINISH_ON": ("2026-07-21", "finish_date"),
    }
    for kind, (value, field) in constraint_cases.items():
        payload = base_payload()
        payload["tasks"][0]["remainingEffortMinutes"] = 480
        payload["tasks"][0]["constraint"] = {"type": kind, "date": value}
        response = solve(request_from(payload))
        assert response.status == SolveStatus.OPTIMAL
        assert response.solution is not None
        actual = getattr(response.solution.tasks[0], field)
        if kind == "START_NO_EARLIER_THAN":
            assert actual >= date.fromisoformat(value)
        elif kind == "FINISH_NO_LATER_THAN":
            assert actual <= date.fromisoformat(value)
        else:
            assert actual == date.fromisoformat(value)


def test_assignment_change_cap_counts_assignment_pairs() -> None:
    payload = base_payload()
    payload["allowedUnitsPercent"] = [25, 50, 100]
    payload["currentAssignments"] = [
        {"taskId": "task-a", "resourceId": "alice", "unitsPercent": 25},
        {"taskId": "task-a", "resourceId": "bob", "unitsPercent": 25},
    ]
    payload["tasks"][0]["maxDurationWorkingDays"] = 1
    payload["constraints"]["deadline"] = "2026-07-20"
    payload["constraints"]["maxChangedAssignmentPairs"] = 1

    response = solve(request_from(payload))

    assert response.status == SolveStatus.INFEASIBLE

    payload["constraints"]["maxChangedAssignmentPairs"] = 2
    accepted = solve(request_from(payload))
    assert accepted.status == SolveStatus.OPTIMAL
    assert accepted.solution is not None
    assert accepted.solution.changed_assignment_pair_count == 2


def test_objective_order_is_fixed_for_auditable_comparison() -> None:
    payload = base_payload()
    payload["objective"]["priorities"] = [
        "MINIMIZE_CHANGE", "MINIMIZE_FINISH", "MINIMIZE_OVERTIME", "MINIMIZE_COST"
    ]

    with pytest.raises(ValueError, match="fixed verified order"):
        request_from(payload)
