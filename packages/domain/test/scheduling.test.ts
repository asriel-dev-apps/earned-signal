import { describe, expect, it } from "vitest";
import { calculateSchedule, ScheduleCycleError } from "../src/index.js";

describe("calculateSchedule", () => {
  it("schedules activity duration across configured working weekdays and holidays", () => {
    const schedule = calculateSchedule({
      projectStart: "2026-07-13",
      defaultCalendarId: "tokyo",
      calendars: [
        {
          id: "tokyo",
          workingWeekdays: [1, 2, 3, 4, 5],
          nonWorkingDates: ["2026-07-15"],
        },
      ],
      activities: [{ id: "A", durationWorkingDays: 5, calendarId: "tokyo", dependencies: [] }],
    });

    expect(schedule.activities[0]).toMatchObject({
      earlyStart: "2026-07-13",
      earlyFinish: "2026-07-20",
    });
  });

  it("applies SS, FF, and SF relationships with working-day lag", () => {
    const schedule = calculateSchedule({
      projectStart: "2026-07-13",
      activities: [
        { id: "A", durationWorkingDays: 3, dependencies: [] },
        {
          id: "B",
          durationWorkingDays: 2,
          dependencies: [{ predecessorId: "A", type: "SS", lagWorkingDays: 1 }],
        },
        {
          id: "C",
          durationWorkingDays: 2,
          dependencies: [{ predecessorId: "A", type: "FF", lagWorkingDays: 1 }],
        },
        {
          id: "D",
          durationWorkingDays: 2,
          dependencies: [{ predecessorId: "A", type: "SF", lagWorkingDays: 1 }],
        },
      ],
    });

    expect(schedule.activities.map(({ id, earlyStart, earlyFinish }) => ({
      id,
      earlyStart,
      earlyFinish,
    }))).toEqual([
      { id: "A", earlyStart: "2026-07-13", earlyFinish: "2026-07-15" },
      { id: "B", earlyStart: "2026-07-14", earlyFinish: "2026-07-15" },
      { id: "C", earlyStart: "2026-07-15", earlyFinish: "2026-07-16" },
      { id: "D", earlyStart: "2026-07-13", earlyFinish: "2026-07-14" },
    ]);
  });

  it("applies date constraints and reports an impossible finish constraint", () => {
    const schedule = calculateSchedule({
      projectStart: "2026-07-13",
      activities: [
        {
          id: "A",
          durationWorkingDays: 2,
          dependencies: [],
          constraint: { type: "START_NO_EARLIER_THAN", date: "2026-07-16" },
        },
        {
          id: "B",
          durationWorkingDays: 3,
          dependencies: [],
          constraint: { type: "MUST_FINISH_ON", date: "2026-07-17" },
        },
        {
          id: "C",
          durationWorkingDays: 2,
          dependencies: [{ predecessorId: "A", type: "FS", lagWorkingDays: 0 }],
          constraint: { type: "FINISH_NO_LATER_THAN", date: "2026-07-20" },
        },
      ],
    });

    expect(schedule.activities).toEqual([
      expect.objectContaining({ id: "A", earlyStart: "2026-07-16", earlyFinish: "2026-07-17" }),
      expect.objectContaining({ id: "B", earlyStart: "2026-07-15", earlyFinish: "2026-07-17" }),
      expect.objectContaining({
        id: "C",
        earlyStart: "2026-07-20",
        earlyFinish: "2026-07-21",
        constraintViolation: { type: "FINISH_NO_LATER_THAN", date: "2026-07-20" },
      }),
    ]);
  });

  it("combines multiple predecessors with an activity-specific resource calendar", () => {
    const schedule = calculateSchedule({
      projectStart: "2026-07-13",
      defaultCalendarId: "project",
      calendars: [
        { id: "project", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
        {
          id: "support",
          workingWeekdays: [2, 3, 4, 5, 6],
          nonWorkingDates: ["2026-07-16"],
        },
      ],
      activities: [
        { id: "A", durationWorkingDays: 2, dependencies: [] },
        {
          id: "B",
          durationWorkingDays: 3,
          calendarId: "support",
          dependencies: [{ predecessorId: "A", type: "FS", lagWorkingDays: 0 }],
        },
        {
          id: "C",
          durationWorkingDays: 1,
          dependencies: [
            { predecessorId: "A", type: "FS", lagWorkingDays: 0 },
            { predecessorId: "B", type: "FF", lagWorkingDays: 0 },
          ],
        },
      ],
    });

    expect(schedule.activities.map(({ id, earlyStart, earlyFinish }) => ({
      id,
      earlyStart,
      earlyFinish,
    }))).toEqual([
      { id: "A", earlyStart: "2026-07-13", earlyFinish: "2026-07-14" },
      { id: "B", earlyStart: "2026-07-15", earlyFinish: "2026-07-18" },
      { id: "C", earlyStart: "2026-07-20", earlyFinish: "2026-07-20" },
    ]);
  });

  it("rejects dependency lag beyond the bounded scheduling range", () => {
    expect(() =>
      calculateSchedule({
        projectStart: "2026-07-13",
        activities: [
          { id: "A", durationWorkingDays: 1, dependencies: [] },
          {
            id: "B",
            durationWorkingDays: 1,
            dependencies: [{ predecessorId: "A", type: "FS", lagWorkingDays: 10_001 }],
          },
        ],
      }),
    ).toThrow("Activity B lag must be a whole number from 0 to 10000");
  });

  it("rejects duplicate predecessor and relationship pairs", () => {
    expect(() =>
      calculateSchedule({
        projectStart: "2026-07-13",
        activities: [
          { id: "A", durationWorkingDays: 1, dependencies: [] },
          {
            id: "B",
            durationWorkingDays: 1,
            dependencies: [
              { predecessorId: "A", type: "FS", lagWorkingDays: 0 },
              { predecessorId: "A", type: "FS", lagWorkingDays: 1 },
            ],
          },
        ],
      }),
    ).toThrow("Activity B has a duplicate dependency");
  });

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
