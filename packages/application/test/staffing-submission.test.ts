import { describe, expect, it, vi } from "vitest";
import {
  ProjectCommandValidationError,
  ProjectNotFoundError,
  createStaffingProposalSubmissionService,
  type ProjectState,
  type StaffingProposalSubmissionRequest,
} from "../src/index.js";

function current(): ProjectState {
  return {
    id: "project-1",
    name: "Project",
    projectStart: "2026-07-01",
    statusDate: "2026-07-01",
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [{ id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] }],
    wbsGroups: [],
    skills: [],
    resources: [{
      id: "resource-1",
      name: "Planner",
      calendarId: "standard",
      dailyCapacityMinutes: 480,
      costRateMinorPerHour: 6_000,
      skillIds: [],
    }],
    assignments: [{ taskId: "task-1", resourceId: "resource-1", unitsPercent: 100 }],
    tasks: [{
      id: "task-1",
      wbs: "1",
      wbsParentId: null,
      name: "Plan",
      owner: "",
      durationWorkingDays: 2,
      measurementMethod: "ZERO_HUNDRED",
      calendarId: "standard",
      dependencies: [],
      constraint: null,
      requiredSkillIds: [],
      budget: 10_000,
      progressPercent: 0,
      actualCost: 0,
      actualMinutes: 0,
    }],
  };
}

function request(): StaffingProposalSubmissionRequest {
  return {
    identity: { issuer: "https://identity.example", subject: "user-1", scopes: [] },
    tenantId: "tenant-1",
    projectId: "project-1",
    name: " Recovery plan ",
    expectedRevision: "7",
    idempotencyKey: "proposal-1",
    remainingEffort: [{
      taskId: "task-1",
      remainingEffortMinutes: 960,
      maxParallelResources: 1,
      provenance: "HUMAN_CONFIRMED",
    }],
    candidateResources: [],
    constraints: {
      version: "staffing-constraints-v1",
      deadline: null,
      maxPlannedLaborCostMinor: null,
      maxOvertimeMinutes: null,
      maxAssignmentChanges: null,
      maxScheduleChanges: null,
      maxCandidateResources: 0,
      requireSkillCoverage: true,
    },
    objective: {
      version: "staffing-objective-v1",
      priorities: ["MINIMIZE_FINISH", "MINIMIZE_OVERTIME", "MINIMIZE_COST", "MINIMIZE_CHANGE"],
    },
  };
}

describe("StaffingProposalSubmissionService", () => {
  it("owns authorization, validation, persistence, hashing, and dispatch orchestration", async () => {
    const calls: string[] = [];
    const create = vi.fn(async () => {
      calls.push("create");
      return { proposal: { id: "proposal-id", status: "REQUESTED" as const }, replayed: false };
    });
    const dispatch = vi.fn(async () => { calls.push("dispatch"); });
    const service = createStaffingProposalSubmissionService({
      authorizer: { authorize: async () => { calls.push("authorize"); return { type: "HUMAN", id: "user-1" }; } },
      workspace: { load: async () => { calls.push("load"); return { current: current(), baseline: current() }; } },
      proposals: { create },
      requestHasher: { hash: async () => "a".repeat(64) },
      dispatch,
    });

    await expect(service.submit(request())).resolves.toEqual({
      proposal: { id: "proposal-id", status: "REQUESTED" },
      replayed: false,
    });
    expect(calls).toEqual(["authorize", "load", "create", "dispatch"]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      projectId: "project-1",
      name: "Recovery plan",
      baseProjectRevision: 7n,
      idempotencyKey: "proposal-1",
      actor: { type: "HUMAN", id: "user-1" },
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      input: expect.objectContaining({ currentRevision: "7", current: expect.objectContaining({ id: "project-1" }) }),
    }));
    expect(dispatch).toHaveBeenCalledWith({ tenantId: "tenant-1", projectId: "project-1", proposalId: "proposal-id" });
  });

  it("rejects missing projects and Baselines before persistence", async () => {
    const create = vi.fn();
    const base = {
      authorizer: { authorize: async () => ({ type: "HUMAN" as const, id: "user-1" }) },
      proposals: { create },
      requestHasher: { hash: async () => "a".repeat(64) },
      dispatch: async () => undefined,
    };
    await expect(createStaffingProposalSubmissionService({
      ...base,
      workspace: { load: async () => null },
    }).submit(request())).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(createStaffingProposalSubmissionService({
      ...base,
      workspace: { load: async () => ({ current: current(), baseline: null }) },
    }).submit(request())).rejects.toEqual(new ProjectCommandValidationError("Staffing Proposal requires an approved Baseline"));
    expect(create).not.toHaveBeenCalled();
  });

  it("turns invalid optimizer input into a stable Application validation error", async () => {
    const service = createStaffingProposalSubmissionService({
      authorizer: { authorize: async () => ({ type: "HUMAN", id: "user-1" }) },
      workspace: { load: async () => ({ current: current(), baseline: current() }) },
      proposals: { create: vi.fn() },
      requestHasher: { hash: async () => "a".repeat(64) },
      dispatch: async () => undefined,
    });
    await expect(service.submit({ ...request(), remainingEffort: [] }))
      .rejects.toBeInstanceOf(ProjectCommandValidationError);
  });
});
