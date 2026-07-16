import type {
  StaffingObjectiveKind,
  StaffingOptimizer,
  StaffingProblemV1,
  StaffingSolverResult,
} from "@earned-signal/application";
import { STAFFING_SOLVER_STAGE_NAMES } from "@earned-signal/application";
import { calculateSchedule } from "@earned-signal/domain";

export interface SolverRequest {
  readonly contractVersion: "staffing.v1";
  readonly requestId: string;
  readonly horizon: { readonly startDate: string; readonly endDate: string };
  readonly defaultWorkingDates: readonly string[];
  readonly fixedTasks: readonly {
    readonly id: string;
    readonly startDate: string;
    readonly finishDate: string;
  }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly remainingEffortMinutes: number;
    readonly requiredSkills: readonly string[];
    readonly workingDates: readonly string[];
    readonly currentDurationWorkingDays: number;
    readonly currentStartDate: string;
    readonly minDurationWorkingDays: number;
    readonly maxDurationWorkingDays: number;
    readonly maxParallelResources: number;
    readonly dependencies: readonly {
      readonly predecessorTaskId: string;
      readonly type: "FS" | "SS" | "FF" | "SF";
      readonly lagWorkingDays: number;
    }[];
    readonly constraint: {
      readonly type: "START_NO_EARLIER_THAN" | "FINISH_NO_LATER_THAN" | "MUST_START_ON" | "MUST_FINISH_ON";
      readonly date: string;
    } | null;
  }[];
  readonly resources: readonly {
    readonly id: string;
    readonly isCandidate: boolean;
    readonly hourlyRateMinor: number;
    readonly skills: readonly string[];
    readonly availability: readonly {
      readonly date: string;
      readonly capacityMinutes: number;
      readonly fixedLoadScaledMinutes: number;
    }[];
  }[];
  readonly currentAssignments: readonly {
    readonly taskId: string;
    readonly resourceId: string;
    readonly unitsPercent: number;
  }[];
  readonly allowedUnitsPercent: readonly [25, 50, 75, 100];
  readonly constraints: {
    readonly deadline: string | null;
    readonly maxCostMinor: number | null;
    readonly maxTotalOvertimeMinutes: number | null;
    readonly maxChangedAssignmentPairs: number | null;
    readonly maxScheduleChanges: number | null;
    readonly maxCandidateResources: number;
  };
  readonly objective: { readonly priorities: readonly StaffingObjectiveKind[] };
}

const DAY = 86_400_000;

function dates(start: string, days: number): readonly string[] {
  const startTime = new Date(`${start}T00:00:00.000Z`).getTime();
  return Array.from({ length: days }, (_, index) =>
    new Date(startTime + index * DAY).toISOString().slice(0, 10));
}

function isWorkingDate(
  value: string,
  calendar: { readonly workingWeekdays: readonly number[]; readonly nonWorkingDates: readonly string[] },
): boolean {
  const day = new Date(`${value}T00:00:00.000Z`).getUTCDay();
  const isoDay = day === 0 ? 7 : day;
  return calendar.workingWeekdays.includes(isoDay) && !calendar.nonWorkingDates.includes(value);
}

export function staffingSolverRequest(problem: StaffingProblemV1): SolverRequest {
  const allDates = dates(problem.current.projectStart, 366);
  const endDate = allDates.at(-1)!;
  if (problem.constraints.deadline !== null && problem.constraints.deadline > endDate) {
    throw new Error("Staffing deadline exceeds the 366-day optimization horizon");
  }
  const calendars = new Map(problem.current.calendars.map((calendar) => [calendar.id, calendar]));
  const defaultCalendar = calendars.get(problem.current.defaultCalendarId);
  if (defaultCalendar === undefined) throw new Error("Default calendar was not found");
  const unfinishedIds = new Set(problem.tasks.map((task) => task.id));
  const currentSchedule = calculateSchedule({
    projectStart: problem.current.projectStart,
    defaultCalendarId: problem.current.defaultCalendarId,
    calendars: problem.current.calendars,
    activities: problem.current.tasks.map((task) => ({
      id: task.id,
      durationWorkingDays: task.durationWorkingDays,
      calendarId: task.calendarId,
      dependencies: task.dependencies,
      ...(task.constraint === null ? {} : { constraint: task.constraint }),
    })),
  });
  const currentStarts = new Map(currentSchedule.activities.map((activity) => [activity.id, activity.earlyStart]));
  const scheduled = new Map(currentSchedule.activities.map((activity) => [activity.id, activity]));
  const effort = new Map(problem.tasks.map((task) => [task.id, task]));
  const candidateIds = new Set(problem.candidateResources.map((resource) => resource.id));
  const resources = [...problem.current.resources, ...problem.candidateResources];
  return {
    contractVersion: "staffing.v1",
    requestId: problem.sourceProjectRevision,
    horizon: { startDate: problem.current.projectStart, endDate },
    defaultWorkingDates: allDates.filter((value) => isWorkingDate(value, defaultCalendar)),
    fixedTasks: problem.current.tasks.filter((task) => !unfinishedIds.has(task.id)).map((task) => {
      const activity = scheduled.get(task.id);
      if (activity === undefined || activity.earlyStart < problem.current.projectStart || activity.earlyFinish > endDate) {
        throw new Error(`Completed Task schedule exceeds the optimization horizon: ${task.id}`);
      }
      return { id: task.id, startDate: activity.earlyStart, finishDate: activity.earlyFinish };
    }),
    tasks: problem.current.tasks.filter((task) => unfinishedIds.has(task.id)).map((task) => {
      const taskEffort = effort.get(task.id)!;
      const calendar = calendars.get(task.calendarId);
      if (calendar === undefined) throw new Error(`Task calendar was not found: ${task.calendarId}`);
      const workingDates = allDates.filter((value) => isWorkingDate(value, calendar));
      return {
        id: task.id,
        remainingEffortMinutes: taskEffort.remainingEffortMinutes,
        requiredSkills: [...task.requiredSkillIds],
        workingDates,
        currentDurationWorkingDays: task.durationWorkingDays,
        currentStartDate: currentStarts.get(task.id)!,
        minDurationWorkingDays: 1,
        maxDurationWorkingDays: Math.min(workingDates.length, 366),
        maxParallelResources: taskEffort.maxParallelResources,
        dependencies: task.dependencies.map((dependency) => ({
          predecessorTaskId: dependency.predecessorId,
          type: dependency.type,
          lagWorkingDays: dependency.lagWorkingDays,
        })),
        constraint: task.constraint === null ? null : { ...task.constraint },
      };
    }),
    resources: resources.map((resource) => {
      const calendar = calendars.get(resource.calendarId);
      if (calendar === undefined) throw new Error(`Resource calendar was not found: ${resource.calendarId}`);
      const fixedAssignments = problem.current.assignments.filter((assignment) =>
        assignment.resourceId === resource.id && !unfinishedIds.has(assignment.taskId));
      return {
        id: resource.id,
        isCandidate: candidateIds.has(resource.id),
        hourlyRateMinor: resource.costRateMinorPerHour,
        skills: [...resource.skillIds],
        availability: allDates.map((value) => ({
          date: value,
          capacityMinutes: isWorkingDate(value, calendar) ? resource.dailyCapacityMinutes : 0,
          fixedLoadScaledMinutes: fixedAssignments.reduce((total, assignment) => {
            const task = problem.current.tasks.find((candidate) => candidate.id === assignment.taskId);
            const activity = scheduled.get(assignment.taskId);
            const taskCalendar = task === undefined ? undefined : calendars.get(task.calendarId);
            if (
              activity === undefined || taskCalendar === undefined ||
              value < activity.earlyStart || value > activity.earlyFinish ||
              !isWorkingDate(value, calendar) || !isWorkingDate(value, taskCalendar)
            ) return total;
            return total + resource.dailyCapacityMinutes * assignment.unitsPercent;
          }, 0),
        })),
      };
    }),
    currentAssignments: problem.current.assignments.filter((assignment) => unfinishedIds.has(assignment.taskId)).map((assignment) => ({ ...assignment })),
    allowedUnitsPercent: [25, 50, 75, 100],
    constraints: {
      deadline: problem.constraints.deadline,
      maxCostMinor: problem.constraints.maxPlannedLaborCostMinor,
      maxTotalOvertimeMinutes: problem.constraints.maxOvertimeMinutes,
      maxChangedAssignmentPairs: problem.constraints.maxAssignmentChanges,
      maxScheduleChanges: problem.constraints.maxScheduleChanges,
      maxCandidateResources: problem.constraints.maxCandidateResources,
    },
    objective: { priorities: [...problem.objective.priorities] },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Solver response must be an object");
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value as number;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function stageName(value: unknown): typeof STAFFING_SOLVER_STAGE_NAMES[number] {
  const name = string(value, "objective name");
  if (!STAFFING_SOLVER_STAGE_NAMES.some((candidate) => candidate === name)) {
    throw new Error("objective name is unsupported");
  }
  return name as typeof STAFFING_SOLVER_STAGE_NAMES[number];
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function staffingSolverResult(problem: StaffingProblemV1, value: unknown): StaffingSolverResult {
  const response = object(value);
  if (response.contractVersion !== "staffing.v1" || response.requestId !== problem.sourceProjectRevision) {
    throw new Error("Solver response does not match the staffing request");
  }
  const status = string(response.status, "status");
  const diagnostics = array(response.diagnostics, "diagnostics").map((entry) => {
    const diagnostic = object(entry);
    return {
      constraint: typeof diagnostic.constraint === "string" ? diagnostic.constraint : string(diagnostic.code, "diagnostic code"),
      message: string(diagnostic.message, "diagnostic message"),
    };
  });
  const metadata = {
    solverVersion: string(response.solverVersion, "solver version"),
    deterministicSeed: integer(response.deterministicSeed, "deterministic seed"),
    workers: integer(response.workers, "workers"),
    timeLimitSecondsPerStage: integer(response.timeLimitSecondsPerStage, "time limit"),
    deterministicTimeLimitPerStage: finiteNumber(response.deterministicTimeLimitPerStage, "deterministic time limit"),
    objectives: array(response.objectives, "objectives").map((entry) => {
      const objective = object(entry);
      return {
        name: stageName(objective.name),
        value: integer(objective.value, "objective value"),
        bestBound: integer(objective.bestBound, "objective best bound"),
      };
    }),
  };
  if (status === "INFEASIBLE" || status === "UNKNOWN" || status === "MODEL_INVALID") {
    return { version: "staffing-solver-result-v1", sourceProjectRevision: problem.sourceProjectRevision, status, diagnostics, metadata };
  }
  if (status !== "OPTIMAL" && status !== "FEASIBLE") throw new Error("Solver returned an unsupported status");
  const solution = object(response.solution);
  const commands = array(solution.commands, "solution commands");
  const optimizedAssignments = commands.flatMap((entry) => {
    const command = object(entry);
    if (command.type !== "assignment.replace") throw new Error("Solver returned an unsupported command");
    const taskId = string(command.taskId, "command taskId");
    return array(command.assignments, "command assignments").map((assignmentValue) => {
      const assignment = object(assignmentValue);
      return { taskId, resourceId: string(assignment.resourceId, "resourceId"), unitsPercent: integer(assignment.unitsPercent, "unitsPercent") };
    });
  });
  const unfinishedIds = new Set(problem.tasks.map((task) => task.id));
  const unchangedCompleted = problem.current.assignments.filter((assignment) => !unfinishedIds.has(assignment.taskId));
  return {
    version: "staffing-solver-result-v1",
    sourceProjectRevision: problem.sourceProjectRevision,
    status,
    diagnostics,
    metadata,
    assignments: [...unchangedCompleted, ...optimizedAssignments],
    taskDurations: array(solution.taskDurations, "task durations").map((entry) => {
      const item = object(entry);
      return { taskId: string(item.taskId, "duration taskId"), durationWorkingDays: integer(item.durationWorkingDays, "duration") };
    }),
    taskStarts: array(solution.taskStarts, "task starts").map((entry) => {
      const item = object(entry);
      return { taskId: string(item.taskId, "start taskId"), start: string(item.start, "start") };
    }),
    selectedCandidateResourceIds: array(solution.selectedCandidateResourceIds, "selected candidates").map((entry) => string(entry, "candidate id")),
  };
}

const MAX_SOLVER_RESPONSE_BYTES = 1_048_576;

async function boundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) > MAX_SOLVER_RESPONSE_BYTES) {
    throw new Error("Staffing solver response exceeds 1 MiB");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_SOLVER_RESPONSE_BYTES) {
        await reader.cancel("response exceeds limit");
        throw new Error("Staffing solver response exceeds 1 MiB");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function createContainerStaffingOptimizer(fetchSolver: (request: Request) => Promise<Response>): StaffingOptimizer {
  return {
    async solve(problem) {
      const response = await fetchSolver(new Request("http://staffing-solver/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(staffingSolverRequest(problem)),
      }));
      if (!response.ok) throw new Error(`Staffing solver returned HTTP ${response.status}`);
      const body = await boundedResponseText(response);
      return staffingSolverResult(problem, JSON.parse(body) as unknown);
    },
  };
}
