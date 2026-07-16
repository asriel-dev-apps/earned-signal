from fastapi import FastAPI

from .contracts import ForecastRequest, ForecastResponse
from .simulator import simulate

app = FastAPI(title="Earned Signal Forecast Simulator", version="forecast.v1")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/simulate", response_model=ForecastResponse, response_model_by_alias=True)
def simulate_forecast(request: ForecastRequest) -> ForecastResponse:
    return simulate(request)
