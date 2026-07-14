import { describe, expect, it } from "vitest";
import { calculateSchedule, ScheduleCycleError } from "../src/index.js";

describe("calculateSchedule", () => {
  it("calculates forward and backward dates for the A/B/C golden case", () => {
    const schedule = calculateSchedule({
      projectStart: "2026-07-13",
      activities: [
        { id: "A", durationWorkingDays: 5, dependencies: [] },
        {
          id: "B",
          durationWorkingDays: 5,
          dependencies: [{ predecessorId: "A", lagWorkingDays: 0 }],
        },
        {
          id: "C",
          durationWorkingDays: 3,
          dependencies: [{ predecessorId: "A", lagWorkingDays: 1 }],
        },
      ],
    });

    expect(schedule).toEqual({
      projectFinish: "2026-07-24",
      activities: [
        {
          id: "A",
          earlyStart: "2026-07-13",
          earlyFinish: "2026-07-17",
          lateStart: "2026-07-13",
          lateFinish: "2026-07-17",
          totalFloatWorkingDays: 0,
          critical: true,
        },
        {
          id: "B",
          earlyStart: "2026-07-20",
          earlyFinish: "2026-07-24",
          lateStart: "2026-07-20",
          lateFinish: "2026-07-24",
          totalFloatWorkingDays: 0,
          critical: true,
        },
        {
          id: "C",
          earlyStart: "2026-07-21",
          earlyFinish: "2026-07-23",
          lateStart: "2026-07-22",
          lateFinish: "2026-07-24",
          totalFloatWorkingDays: 1,
          critical: false,
        },
      ],
    });
  });

  it("reports every activity trapped in a dependency cycle", () => {
    expect(() =>
      calculateSchedule({
        projectStart: "2026-07-13",
        activities: [
          {
            id: "A",
            durationWorkingDays: 1,
            dependencies: [{ predecessorId: "C", lagWorkingDays: 0 }],
          },
          {
            id: "B",
            durationWorkingDays: 1,
            dependencies: [{ predecessorId: "A", lagWorkingDays: 0 }],
          },
          {
            id: "C",
            durationWorkingDays: 1,
            dependencies: [{ predecessorId: "B", lagWorkingDays: 0 }],
          },
        ],
      }),
    ).toThrowError(new ScheduleCycleError(["A", "B", "C"]));
  });

  it("does not report activities that are only blocked by a cycle", () => {
    expect(() =>
      calculateSchedule({
        projectStart: "2026-07-13",
        activities: [
          {
            id: "A",
            durationWorkingDays: 1,
            dependencies: [{ predecessorId: "B", lagWorkingDays: 0 }],
          },
          {
            id: "B",
            durationWorkingDays: 1,
            dependencies: [{ predecessorId: "A", lagWorkingDays: 0 }],
          },
          {
            id: "C",
            durationWorkingDays: 1,
            dependencies: [{ predecessorId: "A", lagWorkingDays: 0 }],
          },
        ],
      }),
    ).toThrowError(new ScheduleCycleError(["A", "B"]));
  });

  it("rejects an activity duration above the bounded scheduling range", () => {
    expect(() =>
      calculateSchedule({
        projectStart: "2026-07-13",
        activities: [{ id: "A", durationWorkingDays: 10_001, dependencies: [] }],
      }),
    ).toThrow("Activity A duration must be a whole number from 1 to 10000");
  });
});
