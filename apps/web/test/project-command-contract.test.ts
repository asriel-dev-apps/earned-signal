import { describe, expect, it } from "vitest";
import type { ProjectCommand } from "@vecta/application";
import { ApiCommandSchema, fromCommand, toCommand } from "../src/project-command-contract.js";

const PARENT_ID = "b0000000-0000-4000-8000-000000000001";
const TASK_ID = "b0000000-0000-4000-8000-000000000002";

describe("project command contract", () => {
  it("round-trips task.generateSubtasks through the wire schema", () => {
    const command: ProjectCommand = {
      type: "task.generateSubtasks",
      parentTaskId: PARENT_ID,
      templateId: "standard-build",
    };
    const wire = ApiCommandSchema.parse(fromCommand(command));
    expect(wire).toEqual(command);
    expect(toCommand(wire)).toEqual(command);
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
});
