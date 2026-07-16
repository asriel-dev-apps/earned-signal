import { describe, expect, it } from "vitest";
import {
  calculateScenario,
  type ProjectState,
  type ScenarioInput,
} from "../src/index.js";

function project(): ProjectState {
  return {
    id: "project-1",
    name: "Scenario project",
    projectStart: "2026-01-05",
    statusDate: "2026-01-09",
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [{
      id: "standard",
      name: "Standard",
      workingWeekdays: [1, 2, 3, 4, 5],
      nonWorkingDates: [],
    }],
    wbsGroups: [],
    skills: [],
    resources: [],
    assignments: [],
    tasks: [{
      id: "A",
      wbs: "1",
      wbsParentId: null,
      name: "Build",
      owner: "",
      durationWorkingDays: 10,
      measurementMethod: "PHYSICAL_PERCENT",
      calendarId: "standard",
      dependencies: [],
      constraint: null,
      requiredSkillIds: [],
      budget: 1_000,
      progressPercent: 50,
      actualCost: 100,
      actualMinutes: 0,
    }, {
      id: "B",
      wbs: "2",
      wbsParentId: null,
      name: "Release",
      owner: "",
      durationWorkingDays: 4,
      measurementMethod: "PHYSICAL_PERCENT",
      calendarId: "standard",
      dependencies: [{ predecessorId: "A", type: "FS", lagWorkingDays: 0 }],
      constraint: null,
      requiredSkillIds: [],
      budget: 500,
      progressPercent: 0,
      actualCost: 0,
      actualMinutes: 0,
    }],
  };
}

function input(overrides: Partial<ScenarioInput> = {}): ScenarioInput {
  const current = project();
  return {
    current,
    baseline: {
      ...current,
      tasks: current.tasks.map((task) => ({
        ...task,
        durationWorkingDays: task.id === "A" ? 8 : task.durationWorkingDays,
        budget: task.id === "A" ? 900 : task.budget,
        progressPercent: 0,
        actualCost: 0,
      })),
    },
    changes: [{
      type: "task.update",
      taskId: "A",
      changes: { durationWorkingDays: 12, budget: 1_200 },
    }, {
      type: "resource.add",
      resource: {
        id: "R",
        name: "Engineer",
        calendarId: "standard",
        dailyCapacityMinutes: 480,
        costRateMinorPerHour: 6_000,
        skillIds: [],
      },
    }, {
      type: "assignment.replace",
      taskId: "A",
      assignments: [{ resourceId: "R", unitsPercent: 100 }],
    }],
    trend: { spi: 0.5, cpi: 0.8 },
    ...overrides,
  };
}

describe("calculateScenario", () => {
  it("applies overrides and deterministically forecasts only unfinished work", () => {
    const source = input();
    const first = calculateScenario(source);
    const second = calculateScenario(source);

    expect(first).toEqual(second);
    expect(first.plan.tasks.find((task) => task.id === "A")).toMatchObject({
      durationWorkingDays: 12,
      budget: 1_200,
      progressPercent: 50,
      actualCost: 100,
    });
    expect(first.comparison).toMatchObject({
      currentFinish: "2026-02-04",
      currentEac: 1_350,
      currentPlannedLaborCost: 0,
      currentCapacity: { overallocatedResourceIds: [], skillGapActivityIds: [] },
      tasks: [
        { taskId: "A", start: "2026-01-05", finish: "2026-01-23" },
        { taskId: "B", start: "2026-01-26", finish: "2026-02-04" },
      ],
    });
    expect(first.factors).toEqual({
      schedule: 2,
      cost: 1.25,
      scheduleFallback: false,
      costFallback: false,
    });
    expect(first.forecast).toMatchObject({
      finish: "2026-02-09",
      eac: 1_475,
      plannedLaborCost: 864_000,
      capacity: {
        overallocatedResourceIds: [],
        skillGapActivityIds: [],
        resources: [{ resourceId: "R", totalDemandMinutes: 8_640 }],
      },
      tasks: [
        { taskId: "A", start: "2026-01-05", finish: "2026-01-28" },
        { taskId: "B", start: "2026-01-29", finish: "2026-02-09" },
      ],
    });
    expect(first.changes).toEqual(source.changes);
  });

  it("does not mutate Current or its tasks", () => {
    const source = input();
    const before = structuredClone(source.current);

    const result = calculateScenario(source);

    expect(source.current).toEqual(before);
    expect(result.plan).not.toBe(source.current);
    expect(result.plan.tasks[0]).not.toBe(source.current.tasks[0]);
  });

  it.each([
    { changes: [{ type: "task.update", taskId: "missing", changes: { budget: 1_000 } }], message: "Unknown task: missing" },
    { changes: [{ type: "task.update", taskId: "A", changes: {} }], message: "Scenario task update requires at least one plan change" },
    { changes: [{ type: "task.update", taskId: "A", changes: { durationWorkingDays: 1.5 } }], message: "Duration must be a whole number" },
    { changes: [{ type: "task.update", taskId: "A", changes: { budget: -1 } }], message: "Budget must not be negative" },
    { changes: [{ type: "task.update", taskId: "A", changes: { progressPercent: 80 } }], message: "Scenario commands cannot change progress or actuals" },
    { changes: [{ type: "baseline.publish", label: "Not allowed" }], message: "Scenario commands cannot publish a Baseline" },
  ])("rejects an invalid plan command", ({ changes, message }) => {
    expect(() => calculateScenario(input({ changes: changes as ScenarioInput["changes"] }))).toThrow(message);
  });

  it.each([
    { spi: null, cpi: null },
    { spi: 0, cpi: -1 },
    { spi: Number.POSITIVE_INFINITY, cpi: Number.NaN },
  ])("uses neutral factors for unusable SPI/CPI trends", (trend) => {
    const result = calculateScenario(input({ changes: [], trend }));

    expect(result.factors).toEqual({
      schedule: 1,
      cost: 1,
      scheduleFallback: true,
      costFallback: true,
    });
    expect(result.forecast).toMatchObject({
      finish: "2026-01-22",
      eac: 1_100,
      plannedLaborCost: 0,
    });
  });

  it("bounds forecast durations when SPI is extremely small", () => {
    const result = calculateScenario(input({
      trend: { spi: 0.000_01, cpi: 1 },
    }));

    expect(result.factors.schedule).toBeCloseTo(100_000);
    expect(result.forecast.finish).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.forecast.capacity.resources[0]?.totalDemandMinutes).toBe(4_800_000);
  });
});
