import { describe, expect, it } from "vitest";
import { applyProjectCommand, type ProjectState } from "../src/index.js";

const project = {
  id: "project-1",
  name: "Capacity plan",
  projectStart: "2026-07-13",
  statusDate: "2026-07-13",
  currency: "JPY",
  defaultCalendarId: "delivery",
  calendars: [
    {
      id: "delivery",
      name: "Delivery",
      workingWeekdays: [1, 2, 3, 4, 5],
      nonWorkingDates: [],
    },
  ],
  wbsGroups: [],
  skills: [{ id: "api", name: "API engineering" }],
  resources: [],
  assignments: [],
  tasks: [
    {
      id: "task-1",
      wbs: "1",
      wbsParentId: null,
      name: "Build API",
      owner: "Delivery lead",
      durationWorkingDays: 2,
      measurementMethod: "PHYSICAL_PERCENT",
      calendarId: "delivery",
      dependencies: [],
      constraint: null,
      requiredSkillIds: ["api"],
      budget: 100_000,
      progressPercent: 0,
      actualCost: 0,
      actualMinutes: 0,
    },
  ],
} satisfies ProjectState;

describe("resource commands", () => {
  it("adds a resource that references configured calendar and skills", () => {
    const next = applyProjectCommand(project, {
      type: "resource.add",
      resource: {
        id: "resource-1",
        name: "Noah Williams",
        calendarId: "delivery",
        dailyCapacityMinutes: 480,
        costRateMinorPerHour: 6_000,
        skillIds: ["api"],
      },
    });

    expect(next.resources).toEqual([
      {
        id: "resource-1",
        name: "Noah Williams",
        calendarId: "delivery",
        dailyCapacityMinutes: 480,
        costRateMinorPerHour: 6_000,
        skillIds: ["api"],
      },
    ]);
  });

  it("rejects a resource without a display name", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "resource.add",
        resource: {
          id: "resource-1",
          name: " ",
          calendarId: "delivery",
          dailyCapacityMinutes: 480,
          costRateMinorPerHour: 6_000,
          skillIds: ["api"],
        },
      }),
    ).toThrow("Resource resource-1 requires a name");
  });

  it("rejects an empty resource update at the application boundary", () => {
    const withResource = applyProjectCommand(project, {
      type: "resource.add",
      resource: {
        id: "resource-1",
        name: "Noah Williams",
        calendarId: "delivery",
        dailyCapacityMinutes: 480,
        costRateMinorPerHour: 6_000,
        skillIds: ["api"],
      },
    });

    expect(() =>
      applyProjectCommand(withResource, {
        type: "resource.update",
        resourceId: "resource-1",
        changes: {},
      }),
    ).toThrow("Resource update requires at least one change");
  });

  it("atomically replaces a task's assignments", () => {
    const withResources = applyProjectCommand(project, {
      type: "resource.add",
      resource: {
        id: "resource-1",
        name: "Noah Williams",
        calendarId: "delivery",
        dailyCapacityMinutes: 480,
        costRateMinorPerHour: 6_000,
        skillIds: ["api"],
      },
    });

    const assigned = applyProjectCommand(withResources, {
      type: "assignment.replace",
      taskId: "task-1",
      assignments: [{ resourceId: "resource-1", unitsPercent: 50 }],
    });
    expect(assigned.assignments).toEqual([
      { taskId: "task-1", resourceId: "resource-1", unitsPercent: 50 },
    ]);

    const cleared = applyProjectCommand(assigned, {
      type: "assignment.replace",
      taskId: "task-1",
      assignments: [],
    });
    expect(cleared.assignments).toEqual([]);
  });

  it("does not delete a resource while it is assigned", () => {
    const assigned = {
      ...project,
      resources: [
        {
          id: "resource-1",
          name: "Noah Williams",
          calendarId: "delivery",
          dailyCapacityMinutes: 480,
          costRateMinorPerHour: 6_000,
          skillIds: ["api"],
        },
      ],
      assignments: [{ taskId: "task-1", resourceId: "resource-1", unitsPercent: 100 }],
    } satisfies ProjectState;

    expect(() =>
      applyProjectCommand(assigned, { type: "resource.delete", resourceId: "resource-1" }),
    ).toThrow("Resource resource-1 has assignments");
  });
});
