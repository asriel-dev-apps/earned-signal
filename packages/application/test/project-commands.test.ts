import { describe, expect, it } from "vitest";
import { applyProjectCommand, type ProjectState, type ProjectTask } from "../src/index.js";

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
  statusDate: "2026-01-20",
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
      plannedEffortMinutes: 480,
      progressBasisPoints: 4_000,
      actualEffortMinutes: 300,
      dailyPlan: { "2026-01-05": 480 },
      actualStart: "2026-01-05",
    }),
  ],
};

describe("applyProjectCommand", () => {
  it("updates one task without mutating the current project state", () => {
    const next = applyProjectCommand(project, {
      type: "task.update",
      taskId: "task-2",
      changes: { progressBasisPoints: 5_500, actualEffortMinutes: 3_660 },
    });

    expect(next.tasks[1]).toMatchObject({
      progressBasisPoints: 5_500,
      actualEffortMinutes: 3_660,
    });
    expect(project.tasks[1]).toMatchObject({
      progressBasisPoints: 4_000,
      actualEffortMinutes: 300,
    });
  });

  it("adds a task without mutating the current task list", () => {
    const added = makeTask({
      id: "task-3",
      parentId: "task-1",
      sortOrder: 2,
      name: "Subtask 1.2",
      assigneeMemberId: "member-1",
      plannedEffortMinutes: 960,
      dailyPlan: { "2026-01-06": 480, "2026-01-07": 480 },
      dependencies: [{ predecessorId: "task-2", type: "FS", lagWorkingDays: 0 }],
    });
    const next = applyProjectCommand(project, { type: "task.add", task: added });
    expect(next.tasks).toEqual([...project.tasks, added]);
    expect(project.tasks).toHaveLength(2);
  });

  it("deletes a task and re-parents its children to null", () => {
    const next = applyProjectCommand(project, { type: "task.delete", taskId: "task-1" });
    expect(next.tasks.map((task) => task.id)).toEqual(["task-2"]);
    expect(next.tasks[0]?.parentId).toBeNull();
  });

  it("rejects progress outside 0..10000 basis points", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { progressBasisPoints: 10_500 },
      }),
    ).toThrow("progress must be whole basis points");
  });

  it("rejects non-whole planned effort minutes", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { plannedEffortMinutes: 480.5 },
      }),
    ).toThrow("planned effort must be whole minutes");
  });

  it("rejects negative daily plan values", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { dailyPlan: { "2026-01-05": -60 } },
      }),
    ).toThrow("daily plan values must be finite and >= 0");
  });

  it("rejects an actual finish that precedes the actual start (R <= S)", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { actualStart: "2026-01-10", actualFinish: "2026-01-05" },
      }),
    ).toThrow("actual finish must not precede");
  });

  it("rejects a parent cycle in the task hierarchy", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-1",
        changes: { parentId: "task-2" },
      }),
    ).toThrow("cycle");
  });

  it("rejects a task that is its own parent", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { parentId: "task-2" },
      }),
    ).toThrow("cannot be its own parent");
  });

  it("rejects an unknown assignee member", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { assigneeMemberId: "member-missing" },
      }),
    ).toThrow("unknown member");
  });

  it("rejects a dependency on an unknown task", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { dependencies: [{ predecessorId: "task-missing", type: "FS", lagWorkingDays: 0 }] },
      }),
    ).toThrow("unknown task");
  });
});
