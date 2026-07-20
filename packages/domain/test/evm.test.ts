import { describe, expect, it } from "vitest";
import {
  calculateEffortEvm,
  calculateTaskEffort,
  taskStatus,
  type EffortTaskInput,
} from "../src/index.js";

// Golden values are self-derived from the §2 formulas on synthetic inputs.
// Person-hours = minutes / 60; person-days = person-hours / 8. No rounding.

describe("calculateTaskEffort", () => {
  it("derives K/M/N/O/P/Q/U/V/X from the §2 formulas", () => {
    const task: EffortTaskInput = {
      id: "T1",
      plannedEffortMinutes: 480, // L = 480 min = 8 person-hours
      progressBasisPoints: 5_000, // T = 0.5
      actualEffortMinutes: 300, // W = 5 person-hours
      dailyPlan: { "2026-07-13": 240, "2026-07-14": 240 }, // Σ = 480 min = 8 h
    };

    expect(calculateTaskEffort(task, "2026-07-13")).toEqual({
      id: "T1",
      progress: 0.5,
      plannedEffortDays: 1, // K = 480 / 60 / 8
      plannedEffortHours: 8, // M = 480 / 60
      plannedEarnedHours: 4, // N = 240 / 60 (only the on/before status-date day)
      plannedProgress: 0.5, // O = N / M = 4 / 8
      plannedStart: "2026-07-13", // P
      plannedFinish: "2026-07-14", // Q
      status: "IN_PROGRESS", // U
      earnedEffortHours: 4, // V = M × T = 8 × 0.5
      actualEffortHours: 5, // W = 300 / 60
      costVarianceHours: -1, // X = V − W = 4 − 5
    });
  });

  it("treats person-day as minutes/60/8 exactly on whole-minute input", () => {
    expect(
      calculateTaskEffort(
        {
          id: "T",
          plannedEffortMinutes: 3_840, // 3840 / 60 / 8 = 8 person-days
          progressBasisPoints: 0,
          actualEffortMinutes: 0,
          dailyPlan: {},
        },
        "2026-07-13",
      ).plannedEffortDays,
    ).toBe(8);
  });

  it("converts basis points to a fraction and scales EV by T", () => {
    const metrics = calculateTaskEffort(
      {
        id: "T",
        plannedEffortMinutes: 600,
        progressBasisPoints: 5_100, // T = 0.51
        actualEffortMinutes: 0,
        dailyPlan: { "2026-07-13": 600 }, // M = 10 person-hours
      },
      "2026-07-13",
    );
    expect(metrics.progress).toBe(0.51);
    expect(metrics.earnedEffortHours).toBe(10 * 0.51); // V = M × 0.51
  });

  it("yields 0 planned progress when the daily plan is empty (div0 → 0)", () => {
    const metrics = calculateTaskEffort(
      {
        id: "T",
        plannedEffortMinutes: 480,
        progressBasisPoints: 2_500,
        actualEffortMinutes: 0,
        dailyPlan: {},
      },
      "2026-07-13",
    );
    expect(metrics.plannedProgress).toBe(0);
    expect(metrics.plannedStart).toBeNull();
    expect(metrics.plannedFinish).toBeNull();
  });
});

describe("taskStatus", () => {
  it("maps T to not-started / in-progress / done", () => {
    expect(taskStatus(0)).toBe("NOT_STARTED");
    expect(taskStatus(4_500)).toBe("IN_PROGRESS");
    expect(taskStatus(10_000)).toBe("DONE");
  });
});

describe("calculateEffortEvm", () => {
  it("rolls up BAC/PV/EV/AC in person-days with SV/CV/SPI/CPI", () => {
    const result = calculateEffortEvm({
      statusDate: "2026-07-14",
      tasks: [
        {
          id: "T1",
          plannedEffortMinutes: 480,
          progressBasisPoints: 10_000, // T = 1
          actualEffortMinutes: 480, // W = 8 h
          dailyPlan: { "2026-07-13": 480 }, // M1 = 8 h, N1 = 8 h, V1 = 8 h
        },
        {
          id: "T2",
          plannedEffortMinutes: 960,
          progressBasisPoints: 2_500, // T = 0.25
          actualEffortMinutes: 600, // W = 10 h
          dailyPlan: { "2026-07-14": 480, "2026-07-15": 480 }, // M2 = 16 h, N2 = 8 h, V2 = 4 h
        },
      ],
    });

    // BAC = M/8 summed = 1 + 2 = 3; PV = N/8 = 1 + 1 = 2;
    // EV = V/8 = 1 + 0.5 = 1.5; AC = W/8 = 1 + 1.25 = 2.25.
    expect(result.rollup).toEqual({
      bac: 3,
      pv: 2,
      ev: 1.5,
      ac: 2.25,
      sv: 1.5 - 2,
      cv: 1.5 - 2.25,
      spi: 1.5 / 2, // 0.75
      cpi: 1.5 / 2.25,
    });
    expect(result.tasks.map((task) => task.id)).toEqual(["T1", "T2"]);
  });

  it("returns '-' for SPI/CPI when PV/AC are zero (div0 → '-')", () => {
    const result = calculateEffortEvm({ statusDate: "2026-07-13", tasks: [] });
    expect(result.rollup).toEqual({
      bac: 0,
      pv: 0,
      ev: 0,
      ac: 0,
      sv: 0,
      cv: 0,
      spi: "-",
      cpi: "-",
    });
  });
});
