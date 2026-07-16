from fastapi.testclient import TestClient

from staffing_solver.api import app
from tests.test_solver import base_payload


def test_health() -> None:
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_contract_is_strict_and_forbids_unknown_fields() -> None:
    response = TestClient(app).post("/solve", json={"contractVersion": "staffing.v1", "unexpected": True})

    assert response.status_code == 422
    errors = response.json()["detail"]
    assert any(error["type"] == "extra_forbidden" for error in errors)


def test_solve_accepts_exact_iso_dates_over_http() -> None:
    response = TestClient(app).post("/solve", json=base_payload())

    assert response.status_code == 200
    assert response.json()["status"] == "OPTIMAL"
