import { describe, expect, it } from "vitest";

import {
  applyProjectCommand,
  type ProjectState,
} from "../src/index.js";

const project: ProjectState = {
  id: "project-1",
  name: "新製品開発",
  projectStart: "2026-07-13",
  statusDate: "2026-07-24",
  currency: "JPY",
  tasks: [
    {
      id: "task-1",
      wbs: "1.1",
      name: "要件定義",
      owner: "佐藤",
      durationWorkingDays: 5,
      measurementMethod: "ZERO_HUNDRED",
      predecessorId: null,
      budget: 600_000,
      progressPercent: 100,
      actualCost: 580_000,
      actualMinutes: 2_280,
    },
    {
      id: "task-2",
      wbs: "1.2",
      name: "設計",
      owner: "田中",
      durationWorkingDays: 8,
      measurementMethod: "PHYSICAL_PERCENT",
      predecessorId: "task-1",
      budget: 900_000,
      progressPercent: 40,
      actualCost: 420_000,
      actualMinutes: 3_120,
    },
  ],
};

describe("applyProjectCommand", () => {
  it("updates one task without mutating the current project state", () => {
    const next = applyProjectCommand(project, {
      type: "task.update",
      taskId: "task-2",
      changes: {
        owner: "鈴木",
        progressPercent: 55,
        actualMinutes: 3_660,
      },
    });

    expect(next).toEqual({
      ...project,
      tasks: [
        project.tasks[0],
        {
          ...project.tasks[1],
          owner: "鈴木",
          progressPercent: 55,
          actualMinutes: 3_660,
        },
      ],
    });
    expect(project.tasks[1]).toMatchObject({
      owner: "田中",
      progressPercent: 40,
      actualMinutes: 3_120,
    });
  });

  it("adds a task without mutating the current task list", () => {
    const addedTask = {
      id: "task-3",
      wbs: "1.3",
      name: "実装",
      owner: "高橋",
      durationWorkingDays: 10,
      measurementMethod: "PHYSICAL_PERCENT",
      predecessorId: "task-2",
      budget: 1_200_000,
      progressPercent: 0,
      actualCost: 0,
      actualMinutes: 0,
    } as const;

    const next = applyProjectCommand(project, {
      type: "task.add",
      task: addedTask,
    });

    expect(next.tasks).toEqual([...project.tasks, addedTask]);
    expect(project.tasks).toHaveLength(2);
  });

  it("deletes one task without mutating the current task list", () => {
    const next = applyProjectCommand(project, {
      type: "task.delete",
      taskId: "task-2",
    });

    expect(next.tasks).toEqual([project.tasks[0]]);
    expect(project.tasks).toHaveLength(2);
  });

  it("rejects task updates that violate project invariants", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { progressPercent: 120 },
      }),
    ).toThrow("Progress must be between 0 and 100");
  });

  it("rejects intermediate progress for the 0/100 measurement method", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-1",
        changes: { progressPercent: 50 },
      }),
    ).toThrow("0/100 progress must be either 0 or 100");
  });

  it("rejects durations that would exhaust the scheduling loop", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { durationWorkingDays: 10_001 },
      }),
    ).toThrow("Duration must be a whole number from 1 to 10000");
  });

  it("rejects dependencies that create a schedule cycle", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-1",
        changes: { predecessorId: "task-2" },
      }),
    ).toThrow("dependency cycle");
  });

  it("stores actual effort as whole minutes", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { actualMinutes: 1.5 },
      }),
    ).toThrow("whole minutes");
  });

  it("stores money as safe whole minor units", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { actualCost: 420_000.5 },
      }),
    ).toThrow("whole minor units");
  });
});
