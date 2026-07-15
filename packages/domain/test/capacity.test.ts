import { describe, expect, it } from "vitest";
import { calculateCapacity } from "../src/index.js";

describe("calculateCapacity", () => {
  it("reports daily over-allocation, planned cost, and skill gaps", () => {
    const result = calculateCapacity({
      periodStart: "2026-07-13",
      periodFinish: "2026-07-15",
      calendars: [
        {
          id: "delivery",
          workingWeekdays: [1, 2, 3, 4, 5],
          nonWorkingDates: ["2026-07-15"],
        },
      ],
      skills: [
        { id: "api", name: "API engineering" },
        { id: "ux", name: "UX design" },
      ],
      resources: [
        {
          id: "R1",
          calendarId: "delivery",
          dailyCapacityMinutes: 480,
          costRateMinorPerHour: 6_000,
          skillIds: ["api"],
        },
      ],
      activities: [
        {
          id: "A1",
          start: "2026-07-13",
          finish: "2026-07-14",
          requiredSkillIds: ["api"],
        },
        {
          id: "A2",
          start: "2026-07-14",
          finish: "2026-07-15",
          requiredSkillIds: ["ux"],
        },
      ],
      assignments: [
        { activityId: "A1", resourceId: "R1", unitsPercent: 100 },
        { activityId: "A2", resourceId: "R1", unitsPercent: 50 },
      ],
    });

    expect(result.resources).toEqual([
      {
        resourceId: "R1",
        totalCapacityMinutes: 960,
        totalDemandMinutes: 1_200,
        overallocatedMinutes: 240,
        utilizationPercent: 125,
        plannedLaborCostMinor: 120_000,
        skillGapActivityIds: ["A2"],
        days: [
          {
            date: "2026-07-13",
            capacityMinutes: 480,
            demandMinutes: 480,
            overallocatedMinutes: 0,
          },
          {
            date: "2026-07-14",
            capacityMinutes: 480,
            demandMinutes: 720,
            overallocatedMinutes: 240,
          },
          {
            date: "2026-07-15",
            capacityMinutes: 0,
            demandMinutes: 0,
            overallocatedMinutes: 0,
          },
        ],
      },
    ]);
    expect(result.overallocatedResourceIds).toEqual(["R1"]);
    expect(result.skillGapActivityIds).toEqual(["A2"]);
  });

  it("treats a required skill as covered when any assigned resource holds it", () => {
    const result = calculateCapacity({
      periodStart: "2026-07-13",
      periodFinish: "2026-07-13",
      calendars: [
        { id: "delivery", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
      ],
      skills: [{ id: "ux", name: "UX design" }],
      resources: [
        {
          id: "R1",
          calendarId: "delivery",
          dailyCapacityMinutes: 480,
          costRateMinorPerHour: 6_000,
          skillIds: [],
        },
        {
          id: "R2",
          calendarId: "delivery",
          dailyCapacityMinutes: 480,
          costRateMinorPerHour: 6_000,
          skillIds: ["ux"],
        },
      ],
      activities: [
        { id: "A1", start: "2026-07-13", finish: "2026-07-13", requiredSkillIds: ["ux"] },
      ],
      assignments: [
        { activityId: "A1", resourceId: "R1", unitsPercent: 50 },
        { activityId: "A1", resourceId: "R2", unitsPercent: 50 },
      ],
    });

    expect(result.skillGapActivityIds).toEqual([]);
    expect(result.resources.map((resource) => resource.skillGapActivityIds)).toEqual([[], []]);
  });
});
