# Forecast simulator

Python 3.12 Monte Carlo service for reproducible project finish-date and cost forecasts. It is computation-only: it does not persist results, mutate Projects, or publish Scenarios.

## Contract

- `GET /health` returns `{"status":"ok"}`.
- `POST /simulate` accepts and returns strict `forecast.v1` JSON. It recomputes `inputHash` from the canonical request excluding that field and rejects mismatches before simulation.
- Unknown fields, coerced numeric strings, duplicate or dangling identifiers, dependency cycles, unsorted calendars, impossible effort/calendar combinations, and unreachable stopping rules are rejected with HTTP 422.

Effort uses a per-task triangular estimate. Tasks in a correlation group share a standard-normal factor according to `coefficientBasisPoints`; every task also has an independent factor. The combined normal variate is mapped through the normal CDF and the triangular inverse CDF. The service then schedules sampled durations through each Task's working calendar and typed FS/SS/FF/SF dependencies. Dependency lag advances on the ordered project `defaultWorkingDates` calendar.

The response contains P50/P80 finish date and total cost, target-date probability, every stopping checkpoint, exact finish-date and deterministic cost histograms, the canonical-input hash, and algorithm/runtime/seed metadata. Total cost starts with the required `completedActualCostMinor`, then adds each unfinished Task's `actualCostMinor` and sampled remaining effort valued at `weightedCostMinorPerHour`. This keeps completed work in every forecast trial without resampling it.

## Bound benchmark

Run the reproducible 100-Task chain and bounded-dense (up to four predecessors per Task) benchmark at the contract's 50,000-iteration limit:

```sh
PYTHONPATH=. .venv/bin/python benchmarks/benchmark_simulator.py
```

The 2026-07-17 development-machine reference run completed the chain in 5.009 seconds and the bounded-dense graph in 7.875 seconds. These values verify the bounded algorithm shape and are not a production latency SLO; deployment acceptance must benchmark the selected Container instance type.

## Reproducibility and stopping

The service uses a local MT19937 generator with a versioned Box-Muller normal transform. Task and group draws use ID-sorted order, so payload array order does not change the random stream. The same canonical input, seed, Python runtime, and algorithm version produces the same response.

At every eligible `checkEvery` checkpoint after `minIterations`, the service compares P50/P80 finish ordinals and costs with the preceding checkpoint. All relative changes must be within `quantileToleranceBasisPoints` for `stableChecks` consecutive comparisons. Otherwise the run continues to `maxIterations` and returns `converged: false`.

## Run and test

```sh
uv sync --extra test
uv run pytest
uv run uvicorn forecast_simulator.api:app --host 127.0.0.1 --port 8080
```

```sh
docker build -t earned-signal-forecast-simulator .
docker run --rm -p 8080:8080 earned-signal-forecast-simulator
```

All runtime dependencies, the uv installer, and the Python base image are pinned. Persist the canonical request, complete response, service image digest, and algorithm version for audit-grade replay.
