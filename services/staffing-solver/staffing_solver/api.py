from fastapi import FastAPI

from .contracts import SolveRequest, SolveResponse
from .solver import solve

app = FastAPI(title="Earned Signal Staffing Solver", version="staffing.v1")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/solve", response_model=SolveResponse, response_model_by_alias=True)
def solve_staffing(request: SolveRequest) -> SolveResponse:
    return solve(request)
