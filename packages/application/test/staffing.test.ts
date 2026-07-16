import { describe, expect, it } from "vitest";
import {
  StaffingProposalValidationError,
  createStaffingProposalService,
  type ProjectState,
  type StaffingProposalRequest,
  type StaffingOptimizer,
  type StaffingSolvedResult,
  type StaffingSolverResult,
} from "../src/index.js";

function project(): ProjectState {
  return {
    id: "project-1",
    name: "Staffing project",
    projectStart: "2026-01-05",
    statusDate: "2026-01-05",
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [{ id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] }],
    wbsGroups: [],
    skills: [{ id: "backend", name: "Backend" }],
    resources: [{
      id: "R1", name: "Senior", calendarId: "standard", dailyCapacityMinutes: 480,
      costRateMinorPerHour: 6_000, skillIds: ["backend"],
    }, {
      id: "R2", name: "Associate", calendarId: "standard", dailyCapacityMinutes: 480,
      costRateMinorPerHour: 3_000, skillIds: ["backend"],
    }],
    assignments: [
      { taskId: "A", resourceId: "R1", unitsPercent: 100 },
      { taskId: "B", resourceId: "R1", unitsPercent: 100 },
    ],
    tasks: [{
      id: "A", wbs: "1", wbsParentId: null, name: "API", owner: "", durationWorkingDays: 2,
      measurementMethod: "PHYSICAL_PERCENT", calendarId: "standard", dependencies: [], constraint: null,
      requiredSkillIds: ["backend"], budget: 100_000, progressPercent: 50, actualCost: 20_000, actualMinutes: 480,
    }, {
      id: "B", wbs: "2", wbsParentId: null, name: "Worker", owner: "", durationWorkingDays: 2,
      measurementMethod: "PHYSICAL_PERCENT", calendarId: "standard", dependencies: [], constraint: null,
      requiredSkillIds: ["backend"], budget: 100_000, progressPercent: 0, actualCost: 0, actualMinutes: 0,
    }],
  };
}

const constraints = {
  version: "staffing-constraints-v1" as const,
  deadline: "2026-01-09",
  maxPlannedLaborCostMinor: 200_000,
  maxOvertimeMinutes: 0,
  maxAssignmentChanges: 2,
  maxScheduleChanges: 0,
  maxCandidateResources: 0,
  requireSkillCoverage: true as const,
};
const objective = {
  version: "staffing-objective-v1" as const,
  priorities: ["MINIMIZE_FINISH", "MINIMIZE_OVERTIME", "MINIMIZE_COST", "MINIMIZE_CHANGE"] as const,
};

function request(overrides: Partial<StaffingProposalRequest> = {}): StaffingProposalRequest {
  return {
    currentRevision: "7",
    current: project(),
    remainingEffort: [
      { taskId: "A", remainingEffortMinutes: 480, maxParallelResources: 2, provenance: "HUMAN_CONFIRMED" as const },
      { taskId: "B", remainingEffortMinutes: 960, maxParallelResources: 2, provenance: "HUMAN_CONFIRMED" as const },
    ],
    constraints,
    objective,
    candidateResources: [],
    ...overrides,
  };
}

function solved(overrides: Partial<StaffingSolvedResult> = {}): StaffingSolverResult {
  return {
    version: "staffing-solver-result-v1",
    sourceProjectRevision: "7",
    status: "OPTIMAL",
    assignments: [
      { taskId: "A", resourceId: "R1", unitsPercent: 100 },
      { taskId: "B", resourceId: "R2", unitsPercent: 100 },
    ],
    taskStarts: [
      { taskId: "A", start: "2026-01-05" },
      { taskId: "B", start: "2026-01-05" },
    ],
    taskDurations: [
      { taskId: "A", durationWorkingDays: 2 },
      { taskId: "B", durationWorkingDays: 2 },
    ],
    selectedCandidateResourceIds: [],
    diagnostics: [],
    metadata: {
      solverVersion: "test-solver-1",
      deterministicSeed: 20260716,
      workers: 1,
      timeLimitSecondsPerStage: 5,
      deterministicTimeLimitPerStage: 1,
      objectives: [
        { name: "finishDayIndex", value: 1, bestBound: 1 },
        { name: "overtimeScaledMinutes", value: 0, bestBound: 0 },
        { name: "costNumerator", value: 864_000_000, bestBound: 864_000_000 },
        { name: "changedAssignmentPairCount", value: 2, bestBound: 2 },
        { name: "scheduleChangeCount", value: 0, bestBound: 0 },
        { name: "candidateResourceCount", value: 0, bestBound: 0 },
        { name: "stableAssignmentScore", value: 300, bestBound: 300 },
        { name: "stableStartScore", value: 0, bestBound: 0 },
      ],
    },
    ...overrides,
  };
}

function solvedWithPrimaryObjectives(
  overrides: Partial<StaffingSolvedResult>,
  values: readonly [number, number, number, number],
): StaffingSolverResult {
  const result = solved(overrides);
  if (result.status !== "OPTIMAL") throw new Error("expected solved fixture");
  return {
    ...result,
    metadata: {
      ...result.metadata,
      objectives: result.metadata.objectives.map((objective, index) =>
        index < values.length
          ? { ...objective, value: values[index]!, bestBound: values[index]! }
          : objective),
    },
  };
}

function optimizer(result: StaffingSolverResult, inspect?: (problem: Parameters<StaffingOptimizer["solve"]>[0]) => void): StaffingOptimizer {
  return { solve: async (problem) => { inspect?.(problem); return result; } };
}

describe("StaffingProposalService", () => {
  it("builds a versioned remaining-effort problem and returns independently verified Scenario changes", async () => {
    const service = createStaffingProposalService({
      optimizer: optimizer(solved(), (problem) => {
        expect(problem).toMatchObject({
          version: "staffing-problem-v1",
          sourceProjectRevision: "7",
          tasks: [
            { id: "A", remainingEffortMinutes: 480, maxParallelResources: 2, remainingEffortProvenance: "HUMAN_CONFIRMED" },
            { id: "B", remainingEffortMinutes: 960, maxParallelResources: 2, remainingEffortProvenance: "HUMAN_CONFIRMED" },
          ],
        });
      }),
      explainer: {
        explain: async (input) => ({ summary: "Split the concurrent work.", details: [input.facts[0]!] }),
      },
    });

    const result = await service.generate(request());

    expect(result).toMatchObject({
      status: "OPTIMAL",
      changes: [{ type: "assignment.replace", taskId: "B", assignments: [{ resourceId: "R2", unitsPercent: 100 }] }],
      metrics: {
        finish: "2026-01-06",
        plannedLaborCostMinor: 144_000,
        overtimeMinutes: 0,
        assignmentChanges: 2,
        scheduleChanges: 0,
        skillGapTaskIds: [],
      },
      explanation: { summary: "Split the concurrent work." },
    });
  });

  it.each(["INFEASIBLE", "UNKNOWN", "MODEL_INVALID"] as const)(
    "keeps %s distinct and does not ask AI to explain an unverified numeric plan",
    async (status) => {
      let explained = false;
      const service = createStaffingProposalService({
        optimizer: optimizer({
          version: "staffing-solver-result-v1", sourceProjectRevision: "7", status,
          diagnostics: [{ constraint: "deadline", message: "No solution" }],
          metadata: {
            solverVersion: "test-solver-1", deterministicSeed: 20260716, workers: 1,
            timeLimitSecondsPerStage: 5, deterministicTimeLimitPerStage: 1, objectives: [],
          },
        }),
        explainer: { explain: async () => { explained = true; return { summary: "", details: [] }; } },
      });

      await expect(service.generate(request()))
        .resolves.toMatchObject({ status, diagnostics: [{ constraint: "deadline" }] });
      expect(explained).toBe(false);
    },
  );

  it("turns a changed start into a plan command and enforces the schedule change cap", async () => {
    const result = solvedWithPrimaryObjectives({
      taskStarts: [
        { taskId: "A", start: "2026-01-05" },
        { taskId: "B", start: "2026-01-07" },
      ],
      taskDurations: [
        { taskId: "A", durationWorkingDays: 2 },
        { taskId: "B", durationWorkingDays: 3 },
      ],
    }, [4, 0, 1_008_000_000, 2]);
    const service = createStaffingProposalService({
      optimizer: optimizer(result),
      explainer: { explain: async () => ({ summary: "Staggered.", details: [] }) },
    });

    await expect(service.generate(request()))
      .rejects.toThrow("schedule change cap");
    const accepted = await service.generate(request({
      constraints: { ...constraints, maxScheduleChanges: 1 },
    }));
    expect(accepted).toMatchObject({
      status: "OPTIMAL",
      changes: expect.arrayContaining([{
        type: "task.update", taskId: "B",
        changes: {
          durationWorkingDays: 3,
          constraint: { type: "MUST_START_ON", date: "2026-01-07" },
        },
      }]),
      metrics: { finish: "2026-01-09", scheduleChanges: 1 },
    });
  });

  it.each([
    { name: "revision", result: solved({ sourceProjectRevision: "8" }), message: "revision" },
    { name: "task entity", result: solved({ taskStarts: [{ taskId: "missing", start: "2026-01-05" }, { taskId: "B", start: "2026-01-05" }] }), message: "unknown or completed task" },
    { name: "resource entity", result: solved({ assignments: [{ taskId: "A", resourceId: "missing", unitsPercent: 100 }] }), message: "unknown resource" },
  ])("rejects a solver result bound to the wrong $name", async ({ result, message }) => {
    const service = createStaffingProposalService({
      optimizer: optimizer(result),
      explainer: { explain: async () => ({ summary: "", details: [] }) },
    });
    await expect(service.generate(request()))
      .rejects.toThrow(message);
  });

  it.each([
    { name: "seed", metadata: { deterministicSeed: 1 }, message: "metadata is invalid" },
    { name: "worker count", metadata: { workers: 2 }, message: "metadata is invalid" },
    { name: "wall-clock limit", metadata: { timeLimitSecondsPerStage: 4 }, message: "metadata is invalid" },
    { name: "deterministic-time limit", metadata: { deterministicTimeLimitPerStage: 2 }, message: "metadata is invalid" },
    {
      name: "stage order",
      metadata: { objectives: [
        { name: "overtimeScaledMinutes", value: 0, bestBound: 0 },
        { name: "finishDayIndex", value: 1, bestBound: 1 },
      ] },
      message: "fixed stage order",
    },
    {
      name: "duplicate stage",
      metadata: { objectives: [
        { name: "finishDayIndex", value: 1, bestBound: 1 },
        { name: "finishDayIndex", value: 1, bestBound: 1 },
      ] },
      message: "fixed stage order",
    },
    {
      name: "missing stability stages",
      metadata: { objectives: solved().metadata.objectives.slice(0, 4) },
      message: "OPTIMAL result is not proven",
    },
    {
      name: "unproven stage",
      metadata: { objectives: solved().metadata.objectives.map((stage, index) =>
        index === 7 ? { ...stage, bestBound: stage.value - 1 } : stage) },
      message: "OPTIMAL result is not proven",
    },
  ])("rejects solver metadata with an invalid $name", async ({ metadata, message }) => {
    const baseline = solved();
    const service = createStaffingProposalService({
      optimizer: optimizer(solved({ metadata: { ...baseline.metadata, ...metadata } as never })),
      explainer: { explain: async () => ({ summary: "", details: [] }) },
    });

    await expect(service.generate(request())).rejects.toThrow(message);
  });

  it("accepts only a fixed prefix for a FEASIBLE result and permits its final stage to be unproven", async () => {
    const baseline = solved();
    const result = solved({
      status: "FEASIBLE",
      metadata: {
        ...baseline.metadata,
        objectives: baseline.metadata.objectives.slice(0, 3).map((stage, index) =>
          index === 2 ? { ...stage, bestBound: stage.value - 1 } : stage),
      },
    });
    const service = createStaffingProposalService({
      optimizer: optimizer(result),
      explainer: { explain: async () => ({ summary: "Feasible.", details: [] }) },
    });

    await expect(service.generate(request())).resolves.toMatchObject({ status: "FEASIBLE" });
  });

  it.each([
    { constraint: { maxPlannedLaborCostMinor: 100_000 }, message: "cost ceiling" },
    { constraint: { maxAssignmentChanges: 1 }, message: "assignment change cap" },
    { constraint: { deadline: "2026-01-05" }, message: "deadline" },
  ])("recomputes and enforces $message", async ({ constraint, message }) => {
    const service = createStaffingProposalService({
      optimizer: optimizer(solved()),
      explainer: { explain: async () => ({ summary: "", details: [] }) },
    });
    await expect(service.generate(request({
      constraints: { ...constraints, ...constraint },
    }))).rejects.toThrow(message);
  });

  it("counts changed Task/Resource pairs rather than assignment commands", async () => {
    const result = solvedWithPrimaryObjectives({
      assignments: [
        { taskId: "A", resourceId: "R1", unitsPercent: 75 },
        { taskId: "A", resourceId: "R2", unitsPercent: 25 },
        { taskId: "B", resourceId: "R1", unitsPercent: 100 },
      ],
    }, [1, 72_000, 1_080_000_000, 2]);
    const service = createStaffingProposalService({
      optimizer: optimizer(result),
      explainer: { explain: async () => ({ summary: "", details: [] }) },
    });

    await expect(service.generate(request({
      constraints: { ...constraints, maxAssignmentChanges: 1, maxOvertimeMinutes: 960 },
    }))).rejects.toThrow("assignment change cap");
    await expect(service.generate(request({
      constraints: { ...constraints, maxAssignmentChanges: 2, maxOvertimeMinutes: 960 },
    }))).resolves.toMatchObject({ metrics: { assignmentChanges: 2 } });
  });

  it("rejects overtime and Skill gaps from the recomputed capacity result", async () => {
    const overloaded = solved({ assignments: project().assignments });
    const overtimeService = createStaffingProposalService({
      optimizer: optimizer(overloaded),
      explainer: { explain: async () => ({ summary: "", details: [] }) },
    });
    await expect(overtimeService.generate(request()))
      .rejects.toThrow("overtime ceiling");

    const withoutSkill = project();
    const noSkillProject = {
      ...withoutSkill,
      resources: withoutSkill.resources.map((resource) => ({ ...resource, skillIds: [] })),
    };
    const skillService = createStaffingProposalService({
      optimizer: optimizer(solved()),
      explainer: { explain: async () => ({ summary: "", details: [] }) },
    });
    await expect(skillService.generate(request({ current: noSkillProject })))
      .rejects.toThrow("Skill coverage");
  });

  it.each([
    {
      name: "remaining effort",
      result: solved({
        assignments: [
          { taskId: "A", resourceId: "R1", unitsPercent: 100 },
          { taskId: "B", resourceId: "R2", unitsPercent: 25 },
        ],
      }),
      request: request(),
      message: "remaining effort",
    },
    {
      name: "maximum parallel Resources",
      result: solved({
        assignments: [
          { taskId: "A", resourceId: "R1", unitsPercent: 100 },
          { taskId: "B", resourceId: "R1", unitsPercent: 50 },
          { taskId: "B", resourceId: "R2", unitsPercent: 50 },
        ],
      }),
      request: request({
        remainingEffort: [
          { taskId: "A", remainingEffortMinutes: 480, maxParallelResources: 2, provenance: "HUMAN_CONFIRMED" },
          { taskId: "B", remainingEffortMinutes: 960, maxParallelResources: 1, provenance: "HUMAN_CONFIRMED" },
        ],
      }),
      message: "maximum parallel Resources",
    },
    {
      name: "assignment units",
      result: solved({
        assignments: [
          { taskId: "A", resourceId: "R1", unitsPercent: 100 },
          { taskId: "B", resourceId: "R2", unitsPercent: 30 },
        ],
      }),
      request: request(),
      message: "assignment units",
    },
  ])("independently rejects solver output that violates $name", async ({ result, request: input, message }) => {
    const service = createStaffingProposalService({
      optimizer: optimizer(result),
      explainer: { explain: async () => ({ summary: "", details: [] }) },
    });

    await expect(service.generate(input)).rejects.toThrow(message);
  });

  it("copies prose-only AI output without allowing it to replace verified numeric fields", async () => {
    const service = createStaffingProposalService({
      optimizer: optimizer(solved()),
      explainer: {
        explain: async () => ({
          summary: "Verified explanation",
          details: ["No overtime"],
          finish: "2099-01-01",
          plannedLaborCostMinor: 0,
        } as never),
      },
    });

    const result = await service.generate(request());
    if (result.status !== "OPTIMAL") throw new StaffingProposalValidationError("Expected a solution");
    expect(result.metrics.finish).toBe("2026-01-06");
    expect(result.metrics.plannedLaborCostMinor).toBe(144_000);
    expect(result.explanation).toEqual({ summary: "Verified explanation", details: ["No overtime"] });
    expect(result.explanation).not.toHaveProperty("finish");
  });

  it("replaces unsupported AI numeric or identifier claims with deterministic verified facts", async () => {
    const service = createStaffingProposalService({
      optimizer: optimizer(solved()),
      explainer: {
        explain: async () => ({
          summary: "Finish moves to 2099-01-01 for task-999.",
          details: ["Planned labor cost is 1."],
        }),
      },
    });

    const result = await service.generate(request());
    if (result.status !== "OPTIMAL") throw new StaffingProposalValidationError("Expected a solution");
    expect(result.explanation.summary).toBe("The proposal satisfies the verified staffing constraints shown below.");
    expect(result.explanation.details).toContain("Verified finish: 2026-01-06");
    expect(result.explanation.details.join(" ")).not.toContain("2099-01-01");
    expect(result.explanation.details.join(" ")).not.toContain("task-999");
  });

  it("falls back when the explainer swaps two verified numeric facts", async () => {
    const service = createStaffingProposalService({
      optimizer: optimizer(solved()),
      explainer: {
        explain: async () => ({
          summary: "A verified proposal is available.",
          details: ["Verified overtime minutes: 144000"],
        }),
      },
    });

    const result = await service.generate(request());
    if (result.status !== "OPTIMAL") throw new StaffingProposalValidationError("Expected a solution");
    expect(result.explanation.details).toContain("Verified overtime minutes: 0");
    expect(result.explanation.details).not.toContain("Verified overtime minutes: 144000");
  });

  it("rejects objective evidence that does not match the verified plan", async () => {
    const invalidEvidence = solved();
    if (invalidEvidence.status !== "OPTIMAL") throw new Error("expected solved fixture");
    const objectives = invalidEvidence.metadata.objectives.map((entry, index) =>
      index === 1 ? { ...entry, value: 144_000, bestBound: 144_000 } : entry);
    const service = createStaffingProposalService({
      optimizer: optimizer(solved({ metadata: { ...invalidEvidence.metadata, objectives } })),
      explainer: { explain: async () => ({ summary: "Verified proposal.", details: [] }) },
    });

    await expect(service.generate(request())).rejects.toThrow(
      "objective evidence does not match the verified plan",
    );
  });

  it("adds only explicitly supplied and solver-selected candidate Resources", async () => {
    const candidate = {
      id: "R3", name: "Confirmed contractor", calendarId: "standard", dailyCapacityMinutes: 480,
      costRateMinorPerHour: 2_000, skillIds: ["backend"],
    };
    const service = createStaffingProposalService({
      optimizer: optimizer(solvedWithPrimaryObjectives({
        selectedCandidateResourceIds: ["R3"],
        assignments: [
          { taskId: "A", resourceId: "R1", unitsPercent: 100 },
          { taskId: "B", resourceId: "R3", unitsPercent: 100 },
        ],
      }, [1, 0, 768_000_000, 2])),
      explainer: { explain: async () => ({ summary: "Add the confirmed contractor.", details: [] }) },
    });

    await expect(service.generate(request({ candidateResources: [candidate] })))
      .rejects.toThrow("candidate Resource cap");

    const result = await service.generate(request({
      candidateResources: [candidate],
      constraints: { ...constraints, maxCandidateResources: 1 },
    }));

    expect(result).toMatchObject({
      status: "OPTIMAL",
      changes: [
        { type: "resource.add", resource: candidate },
        { type: "assignment.replace", taskId: "B", assignments: [{ resourceId: "R3", unitsPercent: 100 }] },
      ],
      metrics: { candidateResources: 1 },
    });
  });

  it("requires human-confirmed remaining effort for every unfinished task", async () => {
    const service = createStaffingProposalService({
      optimizer: optimizer(solved()),
      explainer: { explain: async () => ({ summary: "", details: [] }) },
    });

    await expect(service.generate(request({ remainingEffort: [] })))
      .rejects.toMatchObject({ code: "MISSING_REMAINING_EFFORT" });
    await expect(service.generate(request({
      remainingEffort: [{ taskId: "A", remainingEffortMinutes: 480, maxParallelResources: 2, provenance: "ESTIMATED" as never }],
    }))).rejects.toMatchObject({ code: "MISSING_REMAINING_EFFORT" });
    await expect(service.generate(request({
      remainingEffort: [
        { taskId: "A", remainingEffortMinutes: 480, maxParallelResources: 0, provenance: "HUMAN_CONFIRMED" },
        { taskId: "B", remainingEffortMinutes: 960, maxParallelResources: 2, provenance: "HUMAN_CONFIRMED" },
      ],
    }))).rejects.toMatchObject({ code: "MISSING_REMAINING_EFFORT" });
  });
});
