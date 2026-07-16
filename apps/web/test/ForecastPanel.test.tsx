// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForecastPanel } from "../src/ForecastPanel.js";
import { initialProject } from "../src/demo-project.js";
import type { ForecastRunDocument, ProjectApiClient } from "../src/project-api-client.js";

const scenarioId = "00000000-0000-4000-8000-000000000088";
afterEach(cleanup);

function forecastRun(status: ForecastRunDocument["status"]): ForecastRunDocument {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    status,
    sourceProjectRevision: "7",
    sourceScenarioRevision: "2",
    targetDate: "2026-08-14",
    result: status === "READY" ? {
      contractVersion: "forecast.v1", inputHash: "a".repeat(64), projectId: initialProject.id, sourceRevision: "7",
      iterations: 4_000, converged: true, p50FinishDate: "2026-07-30", p80FinishDate: "2026-08-05",
      p50TotalCostMinor: 1_000_000, p80TotalCostMinor: 1_200_000, targetProbabilityBasisPoints: 8_250,
      stoppingCheckpoints: [{ iteration: 4_000, p50FinishDate: "2026-07-30", p80FinishDate: "2026-08-05", p50TotalCostMinor: 1_000_000, p80TotalCostMinor: 1_200_000 }],
      quantiles: [{ basisPoints: 5000, finishDate: "2026-07-30", totalCostMinor: 1_000_000 }, { basisPoints: 8000, finishDate: "2026-08-05", totalCostMinor: 1_200_000 }],
      finishHistogram: [{ finishDate: "2026-07-28", count: 1_000 }, { finishDate: "2026-08-08", count: 3_000 }],
      costHistogram: [{ lowerBoundMinor: 900_000, upperBoundMinor: 1_050_000, count: 2_000 }, { lowerBoundMinor: 1_050_001, upperBoundMinor: 1_300_000, count: 2_000 }],
      metadata: { algorithmVersion: "earned-signal-monte-carlo-1", runtimeVersion: "3.12.11", seed: 20_260_717, randomGenerator: "mt19937-box-muller-v1", distributionMethod: "correlated-normal-cdf-triangular-quantile-v1", scheduleMethod: "working-calendar-cpm-v1" },
    } : null,
    failure: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    startedAt: status === "REQUESTED" ? null : "2026-07-17T00:00:01.000Z",
    completedAt: status === "READY" ? "2026-07-17T00:00:02.000Z" : null,
  };
}

function client(run: ForecastRunDocument): ProjectApiClient {
  return {
    load: vi.fn(async () => { throw new Error("not used"); }), performance: vi.fn(async () => []), execute: vi.fn(async () => { throw new Error("not used"); }),
    scenarios: vi.fn(async () => []), createScenario: vi.fn(async () => { throw new Error("not used"); }), updateScenario: vi.fn(async () => { throw new Error("not used"); }), runScenario: vi.fn(async () => { throw new Error("not used"); }), discardScenario: vi.fn(async () => { throw new Error("not used"); }), publishScenario: vi.fn(async () => { throw new Error("not used"); }),
    staffingProposals: vi.fn(async () => []), loadStaffingProposal: vi.fn(async () => { throw new Error("not used"); }), requestStaffingProposal: vi.fn(async () => { throw new Error("not used"); }),
    forecastRuns: vi.fn(async () => [run]), loadForecastRun: vi.fn(async () => run), requestForecastRun: vi.fn(async () => ({ run, replayed: false })),
  };
}

function panel(run: ForecastRunDocument) {
  return render(<ForecastPanel project={initialProject} projectRevision="7" scenarioId={scenarioId} scenarioRevision="2" scenarioDirty={false} client={client(run)} defaultTargetDate="2026-08-14" />);
}

describe("ForecastPanel", () => {
  it("shows revision-pinned results, probability, and interpretable histogram ranges", async () => {
    panel(forecastRun("READY"));
    expect(await screen.findByText("82.5%")).toBeTruthy();
    expect(screen.getByLabelText("Current revision 7")).toBeTruthy();
    expect(screen.getByText("Finish by Aug 14, 2026")).toBeTruthy();
    expect(screen.getByText("Jul 28, 2026")).toBeTruthy();
    expect(screen.getByText("Aug 8, 2026")).toBeTruthy();
    expect(screen.getByText("￥900,000")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Target finish date"), { target: { value: "2026-09-01" } });
    expect(screen.getByText("Finish by Aug 14, 2026")).toBeTruthy();
  });

  it("prevents duplicate runs while a Queue job is pending", async () => {
    panel(forecastRun("REQUESTED"));
    const button = await screen.findByRole("button", { name: "Simulation running…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("exposes the minimal all-task correlation controls", () => {
    panel(forecastRun("READY"));
    const toggle = screen.getByLabelText("Correlate all tasks") as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect((screen.getByLabelText("Correlation coefficient basis points") as HTMLInputElement).disabled).toBe(false);
  });

  it("requires explicit human confirmation and resets it when an estimate changes", async () => {
    panel(forecastRun("READY"));
    const button = await screen.findByRole("button", { name: "Run simulation" }) as HTMLButtonElement;
    const confirmation = screen.getByLabelText("Confirm remaining-effort estimates") as HTMLInputElement;

    expect(button.disabled).toBe(true);
    fireEvent.click(confirmation);
    expect(button.disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Build account API optimisticMinutes"), { target: { value: "10" } });
    expect(confirmation.checked).toBe(false);
    expect(button.disabled).toBe(true);
  });
});
