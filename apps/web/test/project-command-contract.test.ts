import { describe, expect, it } from "vitest";
import type { ProjectCommand } from "@vecta/application";
import { ApiCommandSchema, fromCommand, toCommand } from "../src/project-command-contract.js";

const PARENT_ID = "b0000000-0000-4000-8000-000000000001";
const TASK_ID = "b0000000-0000-4000-8000-000000000002";
const TEMPLATE_ID = "b0000000-0000-4000-8000-000000000003";

describe("project command contract", () => {
  it("round-trips task.generateSubtasks through the wire schema", () => {
    const command: ProjectCommand = {
      type: "task.generateSubtasks",
      parentTaskId: PARENT_ID,
      templateId: TEMPLATE_ID,
    };
    const wire = ApiCommandSchema.parse(fromCommand(command));
    expect(wire).toEqual(command);
    expect(toCommand(wire)).toEqual(command);
  });

  it("rejects a non-uuid template id at the wire boundary", () => {
    const result = ApiCommandSchema.safeParse({
      type: "task.generateSubtasks",
      parentTaskId: PARENT_ID,
      templateId: "standard-build",
    });
    expect(result.success).toBe(false);
  });

  it("carries a numeric prorationWeightBp through a task.update round trip", () => {
    const command: ProjectCommand = {
      type: "task.update",
      taskId: TASK_ID,
      changes: { prorationWeightBp: 4_000 },
    };
    const wire = ApiCommandSchema.parse(fromCommand(command));
    expect(wire).toEqual(command);
    expect(toCommand(wire)).toEqual(command);
  });

  it("carries a null prorationWeightBp (un-weighting) through a task.update round trip", () => {
    const command: ProjectCommand = {
      type: "task.update",
      taskId: TASK_ID,
      changes: { prorationWeightBp: null },
    };
    const wire = ApiCommandSchema.parse(fromCommand(command));
    expect(wire).toEqual(command);
    expect(toCommand(wire)).toEqual(command);
  });

  it("rejects an out-of-range proration weight at the wire boundary", () => {
    const result = ApiCommandSchema.safeParse({
      type: "task.update",
      taskId: TASK_ID,
      changes: { prorationWeightBp: 10_001 },
    });
    expect(result.success).toBe(false);
  });

  it("carries processId / productId through a task.update round trip", () => {
    const command: ProjectCommand = {
      type: "task.update",
      taskId: TASK_ID,
      changes: { processId: PARENT_ID, productId: null },
    };
    const wire = ApiCommandSchema.parse(fromCommand(command));
    expect(wire).toEqual(command);
    expect(toCommand(wire)).toEqual(command);
  });

  it("round-trips process master commands through the wire schema", () => {
    const add: ProjectCommand = {
      type: "process.add",
      process: { id: PARENT_ID, name: "Phase A", sortOrder: 0 },
    };
    expect(toCommand(ApiCommandSchema.parse(fromCommand(add)))).toEqual(add);

    const update: ProjectCommand = {
      type: "process.update",
      processId: PARENT_ID,
      changes: { name: "Phase B" },
    };
    expect(toCommand(ApiCommandSchema.parse(fromCommand(update)))).toEqual(update);

    const remove: ProjectCommand = { type: "process.delete", processId: PARENT_ID };
    expect(toCommand(ApiCommandSchema.parse(fromCommand(remove)))).toEqual(remove);
  });

  it("round-trips product master commands through the wire schema", () => {
    const add: ProjectCommand = {
      type: "product.add",
      product: { id: PARENT_ID, name: "Product 1", sortOrder: 2 },
    };
    expect(toCommand(ApiCommandSchema.parse(fromCommand(add)))).toEqual(add);

    const remove: ProjectCommand = { type: "product.delete", productId: PARENT_ID };
    expect(toCommand(ApiCommandSchema.parse(fromCommand(remove)))).toEqual(remove);
  });

  it("round-trips subtask template master commands through the wire schema", () => {
    const add: ProjectCommand = {
      type: "template.add",
      template: {
        id: TEMPLATE_ID,
        name: "Standard build",
        sortOrder: 0,
        subtasks: [
          { name: "Design", weightBp: 6_000 },
          { name: "Review", weightBp: 4_000, dependsOnPrev: { type: "FS", lagWorkingDays: 1 } },
        ],
      },
    };
    expect(toCommand(ApiCommandSchema.parse(fromCommand(add)))).toEqual(add);

    const update: ProjectCommand = {
      type: "template.update",
      templateId: TEMPLATE_ID,
      changes: { name: "Build only", subtasks: [{ name: "Build", weightBp: 10_000 }] },
    };
    expect(toCommand(ApiCommandSchema.parse(fromCommand(update)))).toEqual(update);

    const remove: ProjectCommand = { type: "template.delete", templateId: TEMPLATE_ID };
    expect(toCommand(ApiCommandSchema.parse(fromCommand(remove)))).toEqual(remove);
  });

  it("rejects a template step weight out of range at the wire boundary", () => {
    const result = ApiCommandSchema.safeParse({
      type: "template.add",
      template: {
        id: TEMPLATE_ID,
        name: "Bad",
        sortOrder: 0,
        subtasks: [{ name: "Design", weightBp: 10_001 }],
      },
    });
    expect(result.success).toBe(false);
  });
});
