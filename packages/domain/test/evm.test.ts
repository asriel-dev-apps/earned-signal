import { describe, expect, it } from "vitest";
import { calculateEvm } from "../src/index.js";

describe("calculateEvm", () => {
  it("calculates the approved A/B golden case with unrounded intermediate values", () => {
    expect(
      calculateEvm({
        statusDate: "2026-07-24",
        workPackages: [
          {
            id: "A",
            measurementMethod: "ZERO_HUNDRED",
            baselineBudget: 60_000,
            baselineStart: "2026-07-13",
            baselineFinish: "2026-07-17",
            completed: true,
            measurementDate: "2026-07-17",
            worklogs: [
              { workDate: "2026-07-17", minutes: 720, ratePerMinute: 100 },
            ],
          },
          {
            id: "B",
            measurementMethod: "PHYSICAL_PERCENT",
            baselineBudget: 90_000,
            baselineStart: "2026-07-20",
            baselineFinish: "2026-07-24",
            physicalPercent: 40,
            measurementDate: "2026-07-24",
            worklogs: [
              { workDate: "2026-07-24", minutes: 600, ratePerMinute: 100 },
            ],
          },
        ],
      }),
    ).toEqual({
      bac: 150_000,
      pv: 150_000,
      ev: 96_000,
      ac: 132_000,
      sv: -54_000,
      cv: -36_000,
      spi: 0.64,
      cpi: 0.7273,
      eac: 206_250,
      etc: 74_250,
      vac: -56_250,
      tcpi: 3,
    });
  });

  it("returns null instead of dividing by zero", () => {
    expect(calculateEvm({ statusDate: "2026-07-24", workPackages: [] })).toEqual({
      bac: 0,
      pv: 0,
      ev: 0,
      ac: 0,
      sv: 0,
      cv: 0,
      spi: null,
      cpi: null,
      eac: null,
      etc: null,
      vac: null,
      tcpi: null,
    });
  });

  it("excludes progress measurements and worklogs after the status date", () => {
    expect(
      calculateEvm({
        statusDate: "2026-07-13",
        workPackages: [
          {
            id: "A",
            measurementMethod: "ZERO_HUNDRED",
            baselineBudget: 50_000,
            baselineStart: "2026-07-13",
            baselineFinish: "2026-07-17",
            completed: true,
            measurementDate: "2026-07-14",
            worklogs: [
              { workDate: "2026-07-14", minutes: 60, ratePerMinute: 100 },
            ],
          },
        ],
      }),
    ).toMatchObject({ pv: 10_000, ev: 0, ac: 0, cpi: null, eac: null });
  });

  it.each([
    { physicalPercent: Number.NaN, minutes: 60, ratePerMinute: 100 },
    { physicalPercent: 50, minutes: Number.POSITIVE_INFINITY, ratePerMinute: 100 },
    { physicalPercent: 50, minutes: 60, ratePerMinute: Number.NaN },
  ])("rejects non-finite numeric inputs", ({ physicalPercent, minutes, ratePerMinute }) => {
    expect(() =>
      calculateEvm({
        statusDate: "2026-07-24",
        workPackages: [
          {
            id: "A",
            measurementMethod: "PHYSICAL_PERCENT",
            baselineBudget: 50_000,
            baselineStart: "2026-07-20",
            baselineFinish: "2026-07-24",
            physicalPercent,
            measurementDate: "2026-07-24",
            worklogs: [{ workDate: "2026-07-24", minutes, ratePerMinute }],
          },
        ],
      }),
    ).toThrow();
  });
});
