import { describe, expect, it } from "vitest";
import { toForecastProblemV1, validateForecastResultV1, type ForecastRequestV1, type ForecastResultV1, type ProjectState } from "../src/index.js";

function project(): ProjectState {
  return {
    id: "project-1", name: "Forecast", projectStart: "2026-01-05", statusDate: "2026-01-09", currency: "JPY", defaultCalendarId: "standard",
    calendars: [
      { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: ["2026-01-12"] },
      { id: "four-day", name: "Four day", workingWeekdays: [1, 2, 3, 4], nonWorkingDates: [] },
    ],
    wbsGroups: [], skills: [],
    resources: [
      { id: "R1", name: "One", calendarId: "standard", dailyCapacityMinutes: 480, costRateMinorPerHour: 6_000, skillIds: [] },
      { id: "R2", name: "Two", calendarId: "four-day", dailyCapacityMinutes: 240, costRateMinorPerHour: 9_000, skillIds: [] },
    ],
    assignments: [{ taskId: "A", resourceId: "R1", unitsPercent: 50 }, { taskId: "A", resourceId: "R2", unitsPercent: 100 }, { taskId: "B", resourceId: "R1", unitsPercent: 100 }],
    tasks: [
      { id: "A", wbs: "1", wbsParentId: null, name: "A", owner: "", durationWorkingDays: 3, measurementMethod: "PHYSICAL_PERCENT", calendarId: "standard", dependencies: [], constraint: null, requiredSkillIds: [], budget: 1_000, progressPercent: 50, actualCost: 400, actualMinutes: 300 },
      { id: "B", wbs: "2", wbsParentId: null, name: "B", owner: "", durationWorkingDays: 2, measurementMethod: "PHYSICAL_PERCENT", calendarId: "standard", dependencies: [{ predecessorId: "A", type: "FS", lagWorkingDays: 0 }], constraint: null, requiredSkillIds: [], budget: 2_000, progressPercent: 0, actualCost: 0, actualMinutes: 0 },
      { id: "C", wbs: "3", wbsParentId: null, name: "C", owner: "", durationWorkingDays: 1, measurementMethod: "ZERO_HUNDRED", calendarId: "standard", dependencies: [], constraint: null, requiredSkillIds: [], budget: 500, progressPercent: 100, actualCost: 500, actualMinutes: 480 },
    ],
  };
}

function request(overrides: Partial<ForecastRequestV1> = {}): ForecastRequestV1 {
  return {
    contractVersion: "forecast.v1", current: project(), scenarioChanges: [],
    estimates: [
      { taskId: "A", optimisticMinutes: 300, mostLikelyMinutes: 480, pessimisticMinutes: 720, provenance: "HUMAN_CONFIRMED" },
      { taskId: "B", optimisticMinutes: 240, mostLikelyMinutes: 480, pessimisticMinutes: 960, provenance: "HUMAN_CONFIRMED" },
    ],
    correlationGroups: [{ id: "delivery", taskIds: ["A", "B"], coefficientBasisPoints: 4_000 }],
    seed: 4_294_967_295,
    stopping: { minIterations: 1_000, maxIterations: 5_000, checkEvery: 500, quantileToleranceBasisPoints: 100, stableChecks: 2 },
    targetDate: "2026-02-28", ...overrides,
  };
}

function result(problem = toForecastProblemV1(request(), 7n)): ForecastResultV1 {
  return {
    contractVersion: "forecast.v1", inputHash: "a".repeat(64), projectId: "project-1", sourceRevision: "7", iterations: 2_000, converged: true,
    p50FinishDate: "2026-02-10", p80FinishDate: "2026-02-16", p50TotalCostMinor: 3_000, p80TotalCostMinor: 4_000, targetProbabilityBasisPoints: 10_000,
    stoppingCheckpoints: [1_000, 1_500, 2_000].map((iteration) => ({ iteration, p50FinishDate: "2026-02-10", p80FinishDate: "2026-02-16", p50TotalCostMinor: 3_000, p80TotalCostMinor: 4_000 })),
    quantiles: [{ basisPoints: 5000, finishDate: "2026-02-10", totalCostMinor: 3_000 }, { basisPoints: 8000, finishDate: "2026-02-16", totalCostMinor: 4_000 }],
    finishHistogram: [{ finishDate: "2026-02-10", count: 1_000 }, { finishDate: "2026-02-16", count: 1_000 }],
    costHistogram: [{ lowerBoundMinor: 2_000, upperBoundMinor: 3_000, count: 1_000 }, { lowerBoundMinor: 3_001, upperBoundMinor: 5_000, count: 1_000 }],
    metadata: { algorithmVersion: "earned-signal-monte-carlo-1", runtimeVersion: "3.12", seed: problem.seed, randomGenerator: "mt19937-box-muller-v1", distributionMethod: "correlated-normal-cdf-triangular-quantile-v1", scheduleMethod: "working-calendar-cpm-v1" },
  };
}

describe("forecast.v1", () => {
  it("adapts the Scenario plan into the strict Python contract deterministically", () => {
    const first = toForecastProblemV1(request(), 7n);
    expect(first).toEqual(toForecastProblemV1(request(), "7"));
    expect(first).toMatchObject({ contractVersion: "forecast.v1", projectId: "project-1", sourceRevision: "7", completedActualCostMinor: 500, seed: 4_294_967_295, correlationGroups: [{ id: "delivery", coefficientBasisPoints: 4_000 }], tasks: [
      { id: "A", productiveMinutesPerDay: 480, weightedCostMinorPerHour: 7_500, actualCostMinor: 400, currentStartDate: "2026-01-13", correlationGroupId: "delivery", effortEstimate: { optimisticMinutes: 300 } },
      { id: "B", dependencies: [{ predecessorTaskId: "A", type: "FS", lagWorkingDays: 0 }] },
    ] });
    expect(first.tasks[0]?.workingDates.slice(0, 3)).toEqual(["2026-01-13", "2026-01-14", "2026-01-15"]);
    expect(first.tasks.some((task) => task.id === "C")).toBe(false);
  });

  it("does not pull a constrained root task before its deterministic Scenario start", () => {
    const problem = toForecastProblemV1(request({
      scenarioChanges: [{ type: "task.update", taskId: "A", changes: { constraint: { type: "START_NO_EARLIER_THAN", date: "2026-01-20" } } }],
    }), 7n);
    expect(problem.tasks.find((task) => task.id === "A")?.currentStartDate).toBe("2026-01-20");
    expect(problem.tasks.find((task) => task.id === "B")?.currentStartDate).toBe("2026-01-23");
  });

  it("supports the complete Assignment set when aggregate daily capacity exceeds one person", () => {
    const current = project();
    const extraResources = ["R3", "R4", "R5"].map((id) => ({
      id, name: id, calendarId: "standard", dailyCapacityMinutes: 480,
      costRateMinorPerHour: 6_000, skillIds: [],
    }));
    const problem = toForecastProblemV1(request({
      current: {
        ...current,
        resources: [...current.resources, ...extraResources],
        assignments: [
          ...current.assignments,
          ...extraResources.map((resource) => ({ taskId: "A", resourceId: resource.id, unitsPercent: 100 })),
        ],
      },
    }), 7n);

    expect(problem.tasks.find((task) => task.id === "A")?.productiveMinutesPerDay).toBe(1_920);
  });

  it.each([
    { overrides: { estimates: [] }, message: "Every unfinished task" },
    { overrides: { seed: -1 }, message: "Seed must be" },
    { overrides: { targetDate: "2027-02-01" }, message: "Target date must be" },
    { overrides: { correlationGroups: [{ id: "x", taskIds: ["A", "A"], coefficientBasisPoints: 5_000 }] }, message: "at least two unique" },
    { overrides: { stopping: { minIterations: 1_000, maxIterations: 50_001, checkEvery: 500, quantileToleranceBasisPoints: 100, stableChecks: 2 } }, message: "Maximum iterations" },
    { overrides: { current: { ...project(), id: "invalid project" } }, message: "Project ID" },
  ])("rejects malformed request input: $message", ({ overrides, message }) => {
    expect(() => toForecastProblemV1(request(overrides as Partial<ForecastRequestV1>), 1n)).toThrow(message);
  });

  it("rejects untrusted results that disagree with the pinned problem", () => {
    const problem = toForecastProblemV1(request(), 7n);
    const valid = result(problem);
    expect(validateForecastResultV1(valid, problem, valid.inputHash)).toEqual(valid);
    expect(() => validateForecastResultV1({ ...valid, inputHash: "b".repeat(64) }, problem, valid.inputHash)).toThrow("exact hashed input");
    expect(() => validateForecastResultV1({ ...valid, sourceRevision: "8" }, problem, valid.inputHash)).toThrow("revision-pinned");
    expect(() => validateForecastResultV1({ ...valid, p80FinishDate: "2026-02-01" }, problem, valid.inputHash)).toThrow("P80 finish");
    expect(() => validateForecastResultV1({ ...valid, costHistogram: [{ lowerBoundMinor: 0, upperBoundMinor: 1, count: 1 }] }, problem, valid.inputHash)).toThrow("iteration count");
    expect(() => validateForecastResultV1({ ...valid, targetProbabilityBasisPoints: 9_999 }, problem, valid.inputHash)).toThrow("finish histogram");
    expect(() => validateForecastResultV1({ ...valid, p50FinishDate: "2026-02-09", stoppingCheckpoints: valid.stoppingCheckpoints.map((checkpoint) => ({ ...checkpoint, p50FinishDate: "2026-02-09" })), quantiles: [{ ...valid.quantiles[0]!, finishDate: "2026-02-09" }, valid.quantiles[1]!] }, problem, valid.inputHash)).toThrow("exact histogram quantiles");
    expect(() => validateForecastResultV1({ ...valid, p50TotalCostMinor: 3_001, stoppingCheckpoints: valid.stoppingCheckpoints.map((checkpoint) => ({ ...checkpoint, p50TotalCostMinor: 3_001 })), quantiles: [{ ...valid.quantiles[0]!, totalCostMinor: 3_001 }, valid.quantiles[1]!] }, problem, valid.inputHash)).toThrow("histogram quantile bins");
    expect(() => validateForecastResultV1({ ...valid, iterations: 1_500, stoppingCheckpoints: valid.stoppingCheckpoints.slice(0, 2), finishHistogram: valid.finishHistogram.map((bin) => ({ ...bin, count: 750 })), costHistogram: valid.costHistogram.map((bin) => ({ ...bin, count: 750 })) }, problem, valid.inputHash)).toThrow("convergence");
    expect(() => validateForecastResultV1({ ...valid, p80TotalCostMinor: 1_000_000_000_000_001 }, problem, valid.inputHash)).toThrow("P80 total cost");
    expect(() => validateForecastResultV1({ ...valid, metadata: { ...valid.metadata, seed: 1 } }, problem, valid.inputHash)).toThrow("metadata");
  });
});
