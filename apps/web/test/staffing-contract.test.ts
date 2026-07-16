import { describe, expect, it } from "vitest";
import {
  StaffingProposalCreateSchema,
  staffingProposalHash,
  staffingProposalInput,
} from "../src/staffing-contract.js";

describe("Staffing Proposal HTTP contract", () => {
  const body = {
    name: "Recover delivery",
    expectedRevision: "7",
    remainingEffort: [{
      taskId: "00000000-0000-4000-8000-000000000001",
      remainingEffortMinutes: 600,
      maxParallelResources: 1,
      provenance: "HUMAN_CONFIRMED" as const,
    }],
    candidateResources: [],
    constraints: {
      version: "staffing-constraints-v1" as const,
      deadline: null,
      maxPlannedLaborCostMinor: null,
      maxOvertimeMinutes: 0,
      maxAssignmentChanges: null,
      maxScheduleChanges: null,
      maxCandidateResources: 0,
      requireSkillCoverage: true as const,
    },
    objective: {
      version: "staffing-objective-v1" as const,
      priorities: ["MINIMIZE_FINISH", "MINIMIZE_OVERTIME", "MINIMIZE_COST", "MINIMIZE_CHANGE"] as const,
    },
  };

  it("rejects unknown fields and duplicate objective priorities", () => {
    expect(StaffingProposalCreateSchema.safeParse({ ...body, hiddenFallback: true }).success).toBe(false);
    expect(StaffingProposalCreateSchema.safeParse({
      ...body,
      objective: { ...body.objective, priorities: ["MINIMIZE_FINISH", "MINIMIZE_FINISH", "MINIMIZE_COST", "MINIMIZE_CHANGE"] },
    }).success).toBe(false);
  });

  it("builds a deterministic Application-shaped request hash", async () => {
    const current = {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Project",
      projectStart: "2026-07-01",
      statusDate: "2026-07-15",
      currency: "JPY" as const,
      defaultCalendarId: "standard",
      calendars: [{ id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] }],
      wbsGroups: [],
      skills: [],
      resources: [{
        id: "00000000-0000-4000-8000-000000000003", name: "Planner", calendarId: "standard",
        dailyCapacityMinutes: 480, costRateMinorPerHour: 6_000, skillIds: [],
      }],
      assignments: [{
        taskId: "00000000-0000-4000-8000-000000000001",
        resourceId: "00000000-0000-4000-8000-000000000003",
        unitsPercent: 100,
      }],
      tasks: [{
        id: "00000000-0000-4000-8000-000000000001", wbs: "1", wbsParentId: null,
        name: "Plan", owner: "", durationWorkingDays: 2, measurementMethod: "ZERO_HUNDRED" as const,
        calendarId: "standard", dependencies: [], constraint: null, requiredSkillIds: [], budget: 10_000,
        progressPercent: 0, actualCost: 0, actualMinutes: 0,
      }],
    };
    const parsed = StaffingProposalCreateSchema.parse(body);
    const input = staffingProposalInput(parsed, current);

    expect(input).toEqual({
      currentRevision: "7",
      current,
      remainingEffort: body.remainingEffort,
      candidateResources: [],
      constraints: body.constraints,
      objective: body.objective,
    });
    await expect(staffingProposalHash("Recovery plan", input)).resolves.toMatch(/^[0-9a-f]{64}$/);
    const changed = staffingProposalInput(
      StaffingProposalCreateSchema.parse({ ...body, expectedRevision: "8" }),
      current,
    );
    await expect(staffingProposalHash("Recovery plan", changed)).resolves.not.toBe(
      await staffingProposalHash("Recovery plan", input),
    );
    await expect(staffingProposalHash("Different plan", input)).resolves.not.toBe(
      await staffingProposalHash("Recovery plan", input),
    );
  });
});
