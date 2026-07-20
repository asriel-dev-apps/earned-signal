import { describe, expect, it } from "vitest";
import { projectWbsGrid, type ProjectState, type ProjectTask } from "../src/index.js";

function makeTask(overrides: Partial<ProjectTask> & Pick<ProjectTask, "id">): ProjectTask {
  return {
    parentId: null,
    sortOrder: 0,
    name: "Task",
    process: "",
    product: "",
    reviewRef: "",
    changeRef: "",
    note: "",
    contract: "",
    assigneeMemberId: null,
    plannedEffortMinutes: 0,
    progressBasisPoints: 0,
    actualEffortMinutes: 0,
    dailyPlan: {},
    dailyPlanLocked: false,
    actualStart: null,
    actualFinish: null,
    dependencies: [],
    ...overrides,
  };
}

const project: ProjectState = {
  id: "project-1",
  name: "Effort WBS",
  projectStart: "2026-01-05",
  statusDate: "2026-01-13",
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [
    { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
  ],
  tasks: [
    makeTask({ id: "task-1", sortOrder: 0, name: "Phase A", process: "Phase A" }),
    makeTask({
      id: "task-2",
      parentId: "task-1",
      sortOrder: 1,
      name: "Subtask 1.1",
      assigneeMemberId: "member-1",
      plannedEffortMinutes: 480, // L = 8 h
      progressBasisPoints: 5_000, // T = 0.5
      actualEffortMinutes: 300, // W = 5 h
      dailyPlan: { "2026-01-13": 240, "2026-01-14": 240 }, // M = 8 h, N = 4 h
    }),
  ],
};

describe("projectWbsGrid", () => {
  it("returns one row per task with derived columns equal to the §2 formulas", () => {
    const projection = projectWbsGrid(project);
    expect(projection.rows).toHaveLength(2);

    const leaf = projection.rows.find((row) => row.id === "task-2")!;
    expect(leaf).toMatchObject({
      assigneeName: "Member 01",
      plannedEffortDays: 1, // K = 480 / 60 / 8
      plannedEffortHours: 8, // M
      plannedEarnedHours: 4, // N (only the on/before status-date day)
      plannedProgress: 0.5, // O
      plannedStart: "2026-01-13", // P
      plannedFinish: "2026-01-14", // Q
      progress: 0.5, // T
      status: "IN_PROGRESS", // U
      earnedEffortHours: 4, // V = M × T
      actualEffortHours: 5, // W hours
      costVarianceHours: -1, // X = V − W
    });
  });

  it("computes the project rollup in person-days", () => {
    const { rollup } = projectWbsGrid(project);
    // Only the leaf carries effort: BAC = 8/8 = 1; PV = 4/8 = 0.5;
    // EV = 4/8 = 0.5; AC = 5/8 = 0.625.
    expect(rollup).toEqual({
      bac: 1,
      pv: 0.5,
      ev: 0.5,
      ac: 0.625,
      sv: 0,
      cv: 0.5 - 0.625,
      spi: 1, // EV / PV
      cpi: 0.5 / 0.625,
    });
  });

  it("orders rows by sortOrder and keeps the ⑦ role seam a no-op", () => {
    const privileged = projectWbsGrid(project, { role: "PRIVILEGED" });
    const general = projectWbsGrid(project, { role: "GENERAL" });
    expect(privileged.rows.map((row) => row.id)).toEqual(["task-1", "task-2"]);
    expect(general.rows).toEqual(privileged.rows);
  });
});
