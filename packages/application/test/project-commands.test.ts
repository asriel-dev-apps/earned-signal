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
      predecessorId: null,
      budget: 600_000,
      progressPercent: 100,
      actualCost: 580_000,
      actualHours: 38,
    },
    {
      id: "task-2",
      wbs: "1.2",
      name: "設計",
      owner: "田中",
      durationWorkingDays: 8,
      predecessorId: "task-1",
      budget: 900_000,
      progressPercent: 40,
      actualCost: 420_000,
      actualHours: 52,
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
        actualHours: 61,
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
          actualHours: 61,
        },
      ],
    });
    expect(project.tasks[1]).toMatchObject({
      owner: "田中",
      progressPercent: 40,
      actualHours: 52,
    });
  });

  it("adds a task without mutating the current task list", () => {
    const addedTask = {
      id: "task-3",
      wbs: "1.3",
      name: "実装",
      owner: "高橋",
      durationWorkingDays: 10,
      predecessorId: "task-2",
      budget: 1_200_000,
      progressPercent: 0,
      actualCost: 0,
      actualHours: 0,
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
});
