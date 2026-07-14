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
    tasks: [
      {
        id: "task-1",
        wbs: "1.1",
        name: "Acceptance",
        owner: "Maya Chen",
        durationWorkingDays: 2,
        measurementMethod: "ZERO_HUNDRED",
        predecessorId: null,
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
