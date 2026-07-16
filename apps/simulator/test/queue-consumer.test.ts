import type { ForecastJson, ForecastRun } from "@earned-signal/persistence";
import { ForecastRunStaleError } from "@earned-signal/persistence";
import { describe, expect, it, vi } from "vitest";
import { createForecastExhaustionProcessor, createForecastMessageProcessor } from "../src/queue-consumer.js";
import { ForecastSimulatorHttpError } from "../src/solver-contract.js";

const body = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001",
  runId: "30000000-0000-4000-8000-000000000001",
};
const scenarioId = "40000000-0000-4000-8000-000000000001";

function run(status: ForecastRun["status"] = "REQUESTED"): ForecastRun {
  return {
    id: body.runId, tenantId: body.tenantId, projectId: body.projectId, scenarioId, status,
    sourceProjectRevision: 7n, sourceScenarioRevision: 2n, idempotencyKey: "forecast-1",
    requestHash: "a".repeat(64), input: {}, latestResult: null,
    createdBy: { type: "HUMAN", id: "person-1" }, createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z", startedAt: null, completedAt: null,
  };
}

function ports(overrides: Partial<{
  load: () => Promise<ForecastRun | null>;
  markRunning: () => Promise<ForecastRun>;
  complete: (request: { readonly status: "READY" | "FAILED"; readonly output: unknown }) => Promise<unknown>;
  simulate: () => Promise<ForecastJson>;
}> = {}) {
  const load = vi.fn(overrides.load ?? (async () => run()));
  const markRunning = vi.fn(overrides.markRunning ?? (async () => run("RUNNING")));
  const complete = vi.fn(overrides.complete ?? (async () => undefined));
  const simulate = vi.fn(overrides.simulate ?? (async () => ({ contractVersion: "forecast.v1" })));
  return {
    values: { load, markRunning, complete, simulate },
    processor: createForecastMessageProcessor({
      scenarioId: async () => scenarioId,
      runs: { load, markRunning, complete },
      simulate,
    }),
  };
}

describe("Forecast Queue consumer", () => {
  it("stores a READY result after the idempotent RUNNING transition", async () => {
    const fixture = ports();
    await fixture.processor(body);
    expect(fixture.values.markRunning).toHaveBeenCalledOnce();
    expect(fixture.values.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "READY", forecastRunId: body.runId }));
  });

  it("does not recompute a terminal duplicate delivery", async () => {
    const fixture = ports({ load: async () => run("READY") });
    await fixture.processor(body);
    expect(fixture.values.markRunning).not.toHaveBeenCalled();
    expect(fixture.values.simulate).not.toHaveBeenCalled();
  });

  it("persists permanent simulator rejection as FAILED", async () => {
    const fixture = ports({ simulate: async () => { throw new ForecastSimulatorHttpError(422); } });
    await fixture.processor(body);
    expect(fixture.values.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "FAILED",
      output: expect.objectContaining({ code: "SIMULATOR_REQUEST_REJECTED" }),
    }));
  });

  it("lets transient failures escape for per-message Queue backoff", async () => {
    const fixture = ports({ simulate: async () => { throw new ForecastSimulatorHttpError(503); } });
    await expect(fixture.processor(body)).rejects.toThrow("HTTP 503");
    expect(fixture.values.complete).not.toHaveBeenCalled();
  });

  it("records a stale source as an idempotent FAILED terminal result", async () => {
    const fixture = ports({
      markRunning: async () => { throw new ForecastRunStaleError(7n, 8n, 2n, 3n); },
    });
    await fixture.processor(body);
    expect(fixture.values.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "FAILED",
      output: expect.objectContaining({ code: "FORECAST_SOURCE_STALE" }),
    }));
  });

  it("records retry exhaustion as FAILED without recomputing", async () => {
    const fixture = ports();
    const exhaust = createForecastExhaustionProcessor({
      scenarioId: async () => scenarioId,
      runs: {
        load: fixture.values.load,
        markRunning: fixture.values.markRunning,
        complete: fixture.values.complete,
      },
    });

    await exhaust(body);

    expect(fixture.values.simulate).not.toHaveBeenCalled();
    expect(fixture.values.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "FAILED",
      output: { code: "FORECAST_RETRIES_EXHAUSTED", message: "Forecast simulation retries were exhausted" },
    }));
  });
});
