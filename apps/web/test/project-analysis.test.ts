import type { ProjectState } from "@earned-signal/application";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../src/project-analysis.js";

function zeroHundredProject(progressPercent: 0 | 100): ProjectState {
  return {
    id: "project-1",
    name: "0/100 project",
    projectStart: "2026-07-13",
    statusDate: "2026-07-13",
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [
      {
        id: "standard",
        name: "Standard",
        workingWeekdays: [1, 2, 3, 4, 5],
        nonWorkingDates: [],
      },
    ],
    wbsGroups: [],
    skills: [],
    resources: [],
    assignments: [],
    tasks: [
      {
        id: "task-1",
        wbs: "1.1",
        wbsParentId: null,
        name: "Acceptance",
        owner: "Maya Chen",
        durationWorkingDays: 2,
        measurementMethod: "ZERO_HUNDRED",
        calendarId: "standard",
        dependencies: [],
        constraint: null,
        requiredSkillIds: [],
        budget: 100_000,
        progressPercent,
        actualCost: 0,
        actualMinutes: 0,
      },
    ],
  };
}

describe("analyzeProject", () => {
  it("uses 0/100 earned-value semantics for 0/100 tasks", () => {
    const baseline = zeroHundredProject(0);

    expect(analyzeProject(zeroHundredProject(0), baseline).evm.ev).toBe(0);
    expect(analyzeProject(zeroHundredProject(100), baseline).evm.ev).toBe(100_000);
  });
});
