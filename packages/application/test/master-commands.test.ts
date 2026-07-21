import { describe, expect, it } from "vitest";
import { applyProjectCommand, projectWbsGrid, type ProjectState } from "../src/index.js";

const project: ProjectState = {
  id: "project-1",
  name: "Effort WBS",
  projectStart: "2026-01-05",
  statusDate: "2026-01-05",
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [],
  processes: [{ id: "process-1", name: "Phase A", sortOrder: 0 }],
  products: [{ id: "product-1", name: "Product 1", sortOrder: 0 }],
  tasks: [
    {
      id: "task-1",
      parentId: null,
      sortOrder: 0,
      name: "Subtask 1.1",
      processId: "process-1",
      productId: "product-1",
      note: "",
      contract: "",
      assigneeMemberId: null,
      plannedEffortMinutes: 480,
      progressBasisPoints: 0,
      actualEffortMinutes: 0,
      prorationWeightBp: null,
      dailyPlan: {},
      actualStart: null,
      actualFinish: null,
      dependencies: [],
    },
  ],
};

describe("process master commands", () => {
  it("adds a process master", () => {
    const next = applyProjectCommand(project, {
      type: "process.add",
      process: { id: "process-2", name: "Phase B", sortOrder: 1 },
    });
    expect(next.processes).toEqual([
      { id: "process-1", name: "Phase A", sortOrder: 0 },
      { id: "process-2", name: "Phase B", sortOrder: 1 },
    ]);
  });

  it("renames a process master", () => {
    const next = applyProjectCommand(project, {
      type: "process.update",
      processId: "process-1",
      changes: { name: "Design phase" },
    });
    expect(next.processes[0]).toMatchObject({ id: "process-1", name: "Design phase" });
  });

  it("rejects a process without a name", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "process.add",
        process: { id: "process-2", name: " ", sortOrder: 1 },
      }),
    ).toThrow("Process process-2 requires a name");
  });

  it("rejects an empty process update", () => {
    expect(() =>
      applyProjectCommand(project, { type: "process.update", processId: "process-1", changes: {} }),
    ).toThrow("Process update requires at least one change");
  });

  it("does not delete a process while a task references it", () => {
    expect(() =>
      applyProjectCommand(project, { type: "process.delete", processId: "process-1" }),
    ).toThrow("used by a task");
  });

  it("deletes an unreferenced process", () => {
    const withSpare = applyProjectCommand(project, {
      type: "process.add",
      process: { id: "process-2", name: "Phase B", sortOrder: 1 },
    });
    const next = applyProjectCommand(withSpare, { type: "process.delete", processId: "process-2" });
    expect(next.processes.map((process) => process.id)).toEqual(["process-1"]);
  });

  it("rejects a task update referencing an unknown process", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-1",
        changes: { processId: "process-missing" },
      }),
    ).toThrow("unknown process");
  });
});

describe("product master commands", () => {
  it("adds a product master", () => {
    const next = applyProjectCommand(project, {
      type: "product.add",
      product: { id: "product-2", name: "Product 2", sortOrder: 1 },
    });
    expect(next.products).toEqual([
      { id: "product-1", name: "Product 1", sortOrder: 0 },
      { id: "product-2", name: "Product 2", sortOrder: 1 },
    ]);
  });

  it("does not delete a product while a task references it", () => {
    expect(() =>
      applyProjectCommand(project, { type: "product.delete", productId: "product-1" }),
    ).toThrow("used by a task");
  });

  it("rejects a task update referencing an unknown product", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-1",
        changes: { productId: "product-missing" },
      }),
    ).toThrow("unknown product");
  });
});

describe("projection resolves master names", () => {
  it("surfaces processName and productName on the grid row", () => {
    const row = projectWbsGrid(project).rows.find((entry) => entry.id === "task-1")!;
    expect(row).toMatchObject({
      processId: "process-1",
      productId: "product-1",
      processName: "Phase A",
      productName: "Product 1",
    });
  });

  it("leaves resolved names empty when unset", () => {
    const cleared = applyProjectCommand(project, {
      type: "task.update",
      taskId: "task-1",
      changes: { processId: null, productId: null },
    });
    const row = projectWbsGrid(cleared).rows.find((entry) => entry.id === "task-1")!;
    expect(row).toMatchObject({ processName: "", productName: "" });
  });
});
