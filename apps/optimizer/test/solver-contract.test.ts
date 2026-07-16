import type { StaffingProblemV1 } from "@earned-signal/application";
import { describe, expect, it } from "vitest";
import { createContainerStaffingOptimizer, staffingSolverRequest, staffingSolverResult } from "../src/solver-contract.js";

const problem: StaffingProblemV1 = {
  version: "staffing-problem-v1",
  sourceProjectRevision: "4",
  current: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Example",
    projectStart: "2026-07-17",
    statusDate: "2026-07-17",
    currency: "JPY",
    defaultCalendarId: "weekday",
    calendars: [{ id: "weekday", name: "Weekday", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] }],
    wbsGroups: [],
    skills: [{ id: "skill-a", name: "Skill A" }],
    resources: [{ id: "resource-a", name: "A", calendarId: "weekday", dailyCapacityMinutes: 480, costRateMinorPerHour: 6_000, skillIds: ["skill-a"] }],
    assignments: [
      { taskId: "task-a", resourceId: "resource-a", unitsPercent: 100 },
      { taskId: "task-done", resourceId: "resource-a", unitsPercent: 50 },
    ],
    tasks: [
      { id: "task-a", wbs: "1", wbsParentId: null, name: "A", owner: "", durationWorkingDays: 2, measurementMethod: "ZERO_HUNDRED", calendarId: "weekday", dependencies: [], constraint: null, requiredSkillIds: ["skill-a"], budget: 10_000, progressPercent: 0, actualCost: 0, actualMinutes: 0 },
      { id: "task-done", wbs: "2", wbsParentId: null, name: "Done", owner: "", durationWorkingDays: 1, measurementMethod: "ZERO_HUNDRED", calendarId: "weekday", dependencies: [], constraint: null, requiredSkillIds: [], budget: 1_000, progressPercent: 100, actualCost: 1_000, actualMinutes: 60 },
    ],
  },
  tasks: [{ id: "task-a", remainingEffortMinutes: 480, maxParallelResources: 1, remainingEffortProvenance: "HUMAN_CONFIRMED" }],
  candidateResources: [],
  constraints: { version: "staffing-constraints-v1", deadline: "2026-07-20", maxPlannedLaborCostMinor: null, maxOvertimeMinutes: 0, maxAssignmentChanges: 1, maxScheduleChanges: 1, maxCandidateResources: 0, requireSkillCoverage: true },
  objective: { version: "staffing-objective-v1", priorities: ["MINIMIZE_FINISH", "MINIMIZE_OVERTIME", "MINIMIZE_COST", "MINIMIZE_CHANGE"] },
};

describe("staffing solver boundary", () => {
  it("projects calendars, hard caps, and objective priorities without treating weekends as working dates", () => {
    const request = staffingSolverRequest(problem);
    expect(request.defaultWorkingDates.slice(0, 2)).toEqual(["2026-07-17", "2026-07-20"]);
    expect(request.constraints.maxChangedAssignmentPairs).toBe(1);
    expect(request.objective.priorities).toEqual(problem.objective.priorities);
    expect(request.fixedTasks).toEqual([{ id: "task-done", startDate: "2026-07-17", finishDate: "2026-07-17" }]);
    expect(request.resources[0]?.availability.slice(0, 4)).toEqual([
      { date: "2026-07-17", capacityMinutes: 480, fixedLoadScaledMinutes: 24_000 },
      { date: "2026-07-18", capacityMinutes: 0, fixedLoadScaledMinutes: 0 },
      { date: "2026-07-19", capacityMinutes: 0, fixedLoadScaledMinutes: 0 },
      { date: "2026-07-20", capacityMinutes: 480, fixedLoadScaledMinutes: 0 },
    ]);
  });

  it("keeps completed assignment load on Resource-working days inside a Task schedule span", () => {
    const sparseCalendar = {
      id: "sparse",
      name: "Sparse Task calendar",
      workingWeekdays: [1, 2, 3, 4, 5],
      nonWorkingDates: ["2026-07-20"],
    };
    const completedAcrossHoliday: StaffingProblemV1 = {
      ...problem,
      current: {
        ...problem.current,
        calendars: [...problem.current.calendars, sparseCalendar],
        tasks: problem.current.tasks.map((task) => task.id === "task-done"
          ? { ...task, calendarId: sparseCalendar.id, durationWorkingDays: 2 }
          : task),
      },
    };

    const request = staffingSolverRequest(completedAcrossHoliday);
    const resource = request.resources.find((item) => item.id === "resource-a");
    expect(resource?.availability.find((item) => item.date === "2026-07-20"))
      .toMatchObject({ capacityMinutes: 480, fixedLoadScaledMinutes: 24_000 });
  });

  it("retains a completed predecessor as a fixed dependency boundary", () => {
    const withCompletedPredecessor: StaffingProblemV1 = {
      ...problem,
      current: {
        ...problem.current,
        tasks: problem.current.tasks.map((task) => task.id === "task-a"
          ? { ...task, dependencies: [{ predecessorId: "task-done", type: "FS", lagWorkingDays: 0 }] }
          : task),
      },
    };

    expect(staffingSolverRequest(withCompletedPredecessor).tasks[0]?.dependencies).toEqual([
      { predecessorTaskId: "task-done", type: "FS", lagWorkingDays: 0 },
    ]);
  });

  it("keeps completed assignments unchanged when translating a solved response", () => {
    const result = staffingSolverResult(problem, {
      contractVersion: "staffing.v1",
      requestId: "4",
      status: "OPTIMAL",
      diagnostics: [],
      solverVersion: "9.14.0",
      deterministicSeed: 20260716,
      workers: 1,
      timeLimitSecondsPerStage: 5,
      deterministicTimeLimitPerStage: 1,
      objectives: [{ name: "finishDayIndex", value: 1, bestBound: 1 }],
      solution: {
        commands: [{ type: "assignment.replace", taskId: "task-a", assignments: [{ resourceId: "resource-a", unitsPercent: 75 }] }],
        taskDurations: [{ taskId: "task-a", durationWorkingDays: 2 }],
        taskStarts: [{ taskId: "task-a", start: "2026-07-17" }],
        selectedCandidateResourceIds: [],
      },
    });
    expect(result.status).toBe("OPTIMAL");
    if (result.status !== "OPTIMAL") throw new Error("expected solved result");
    expect(result.assignments).toContainEqual({ taskId: "task-done", resourceId: "resource-a", unitsPercent: 50 });
    expect(result.metadata).toMatchObject({ solverVersion: "9.14.0", workers: 1 });
  });

  it("stops reading solver responses larger than one MiB", async () => {
    const optimizer = createContainerStaffingOptimizer(async () => new Response(new Uint8Array(1_048_577)));

    await expect(optimizer.solve(problem)).rejects.toThrow("Staffing solver response exceeds 1 MiB");
  });
});
