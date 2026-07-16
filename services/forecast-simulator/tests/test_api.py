from fastapi.testclient import TestClient

from forecast_simulator.api import app
from tests.test_simulator import payload


def test_health() -> None:
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_contract_is_strict_and_versioned() -> None:
    response = TestClient(app).post(
        "/simulate", json={"contractVersion": "forecast.v1", "unexpected": True}
    )

    assert response.status_code == 422
    assert any(error["type"] == "extra_forbidden" for error in response.json()["detail"])


def test_simulate_returns_camel_case_forecast_v1_response() -> None:
    response = TestClient(app).post("/simulate", json=payload())

    assert response.status_code == 200
    result = response.json()
    assert result["contractVersion"] == "forecast.v1"
    assert result["projectId"] == "project-1"
    assert result["iterations"] >= 100
    assert result["quantiles"][0]["basisPoints"] == 5000
