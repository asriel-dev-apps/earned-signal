import {
  calculateSchedule,
  MAX_ACTIVITY_DURATION_WORKING_DAYS,
  type CapacityResult,
  type ScheduleResult,
} from "@earned-signal/domain";
import {
  applyProjectCommand,
  calculateProjectCapacity,
  type ProjectAssignment,
  type ProjectResource,
  type ProjectState,
} from "./project-state.js";
import type { ScenarioPlanCommand } from "./scenario.js";

export type StaffingSolverStatus =
  | "OPTIMAL"
  | "FEASIBLE"
  | "INFEASIBLE"
  | "UNKNOWN"
  | "MODEL_INVALID";

export type StaffingObjectiveKind =
  | "MINIMIZE_FINISH"
  | "MINIMIZE_COST"
  | "MINIMIZE_OVERTIME"
  | "MINIMIZE_CHANGE";

export const STAFFING_OBJECTIVE_PRIORITIES = [
  "MINIMIZE_FINISH",
  "MINIMIZE_OVERTIME",
  "MINIMIZE_COST",
  "MINIMIZE_CHANGE",
] as const satisfies readonly StaffingObjectiveKind[];

export const STAFFING_SOLVER_STAGE_NAMES = [
  "finishDayIndex",
  "overtimeScaledMinutes",
  "costNumerator",
  "changedAssignmentPairCount",
  "scheduleChangeCount",
  "candidateResourceCount",
  "stableAssignmentScore",
  "stableStartScore",
] as const;

type StaffingSolverStageName = typeof STAFFING_SOLVER_STAGE_NAMES[number];

export interface StaffingConstraintsV1 {
  readonly version: "staffing-constraints-v1";
  readonly deadline: string | null;
  readonly maxPlannedLaborCostMinor: number | null;
  readonly maxOvertimeMinutes: number | null;
  readonly maxAssignmentChanges: number | null;
  readonly maxScheduleChanges: number | null;
  readonly maxCandidateResources: number;
  readonly requireSkillCoverage: true;
}

export interface StaffingObjectiveV1 {
  readonly version: "staffing-objective-v1";
  readonly priorities: readonly StaffingObjectiveKind[];
}

export interface ConfirmedRemainingEffort {
  readonly taskId: string;
  readonly remainingEffortMinutes: number;
  readonly maxParallelResources: number;
  readonly provenance: "HUMAN_CONFIRMED";
}

export interface StaffingProblemTaskV1 {
  readonly id: string;
  readonly remainingEffortMinutes: number;
  readonly maxParallelResources: number;
  readonly remainingEffortProvenance: "HUMAN_CONFIRMED";
}

export interface StaffingProblemV1 {
  readonly version: "staffing-problem-v1";
  readonly sourceProjectRevision: string;
  readonly current: ProjectState;
  readonly tasks: readonly StaffingProblemTaskV1[];
  readonly candidateResources: readonly ProjectResource[];
  readonly constraints: StaffingConstraintsV1;
  readonly objective: StaffingObjectiveV1;
}

export interface StaffingSolverDiagnostic {
  readonly constraint: string;
  readonly message: string;
}

export interface StaffingSolverMetadata {
  readonly solverVersion: string;
  readonly deterministicSeed: number;
  readonly workers: number;
  readonly timeLimitSecondsPerStage: number;
  readonly deterministicTimeLimitPerStage: number;
  readonly objectives: readonly {
    readonly name: StaffingSolverStageName;
    readonly value: number;
    readonly bestBound: number;
  }[];
}

interface StaffingSolverEnvelope {
  readonly version: "staffing-solver-result-v1";
  readonly sourceProjectRevision: string;
  readonly diagnostics: readonly StaffingSolverDiagnostic[];
  readonly metadata: StaffingSolverMetadata;
}

export interface StaffingSolvedResult extends StaffingSolverEnvelope {
  readonly status: "OPTIMAL" | "FEASIBLE";
  /** Complete desired Assignment set. Omission of a Task clears its Assignments. */
  readonly assignments: readonly ProjectAssignment[];
  /** Optional changed or unchanged starts for unfinished Tasks. Omitted Tasks retain their Current start. */
  readonly taskStarts?: readonly { readonly taskId: string; readonly start: string }[];
  /** Exactly one proposed duration for every unfinished Task and none for completed Tasks. */
  readonly taskDurations: readonly { readonly taskId: string; readonly durationWorkingDays: number }[];
  readonly selectedCandidateResourceIds: readonly string[];
}

export interface StaffingUnsolvedResult extends StaffingSolverEnvelope {
  readonly status: "INFEASIBLE" | "UNKNOWN" | "MODEL_INVALID";
}

export type StaffingSolverResult = StaffingSolvedResult | StaffingUnsolvedResult;

export interface StaffingOptimizer {
  solve(problem: StaffingProblemV1): Promise<StaffingSolverResult>;
}

export interface StaffingExplanation {
  readonly summary: string;
  readonly details: readonly string[];
}

export interface StaffingExplanationInput {
  readonly facts: readonly string[];
  readonly changeDescriptions: readonly string[];
}

export interface StaffingExplainer {
  explain(input: StaffingExplanationInput): Promise<StaffingExplanation>;
}

export interface StaffingProposalRequest {
  readonly currentRevision: string;
  readonly current: ProjectState;
  readonly remainingEffort: readonly ConfirmedRemainingEffort[];
  readonly candidateResources?: readonly ProjectResource[];
  readonly constraints: StaffingConstraintsV1;
  readonly objective: StaffingObjectiveV1;
}

export interface StaffingProposalMetrics {
  readonly finish: string;
  readonly plannedLaborCostMinor: number;
  readonly overtimeMinutes: number;
  readonly assignmentChanges: number;
  readonly scheduleChanges: number;
  readonly candidateResources: number;
  readonly skillGapTaskIds: readonly string[];
  readonly capacity: CapacityResult;
}

export interface StaffingProposalSolution {
  readonly status: "OPTIMAL" | "FEASIBLE";
  readonly problem: StaffingProblemV1;
  readonly changes: readonly ScenarioPlanCommand[];
  readonly plan: ProjectState;
  readonly metrics: StaffingProposalMetrics;
  readonly explanation: StaffingExplanation;
  readonly diagnostics: readonly StaffingSolverDiagnostic[];
  readonly solverMetadata: StaffingSolverMetadata;
}

export interface StaffingProposalUnsolved {
  readonly status: "INFEASIBLE" | "UNKNOWN" | "MODEL_INVALID";
  readonly problem: StaffingProblemV1;
  readonly diagnostics: readonly StaffingSolverDiagnostic[];
  readonly solverMetadata: StaffingSolverMetadata;
}

export type StaffingProposalResult = StaffingProposalSolution | StaffingProposalUnsolved;

export interface StaffingProposalService {
  generate(request: StaffingProposalRequest): Promise<StaffingProposalResult>;
}

export class StaffingProposalValidationError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_STAFFING_PROPOSAL" | "MISSING_REMAINING_EFFORT" = "INVALID_STAFFING_PROPOSAL",
  ) {
    super(message);
    this.name = "StaffingProposalValidationError";
  }
}

function invalid(message: string): never {
  throw new StaffingProposalValidationError(message);
}

function validatedSolverMetadata(value: unknown, status: StaffingSolverStatus): StaffingSolverMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("Staffing solver metadata is invalid");
  const metadata = value as Partial<StaffingSolverMetadata>;
  if (
    typeof metadata.solverVersion !== "string" || metadata.solverVersion.trim().length === 0 ||
    metadata.deterministicSeed !== 20260716 ||
    metadata.workers !== 1 ||
    metadata.timeLimitSecondsPerStage !== 5 ||
    metadata.deterministicTimeLimitPerStage !== 1 ||
    !Array.isArray(metadata.objectives) || metadata.objectives.some((objective) =>
      typeof objective !== "object" || objective === null ||
      !Number.isSafeInteger(objective.value) || !Number.isSafeInteger(objective.bestBound))
  ) {
    invalid("Staffing solver metadata is invalid");
  }
  if (
    metadata.objectives.length > STAFFING_SOLVER_STAGE_NAMES.length ||
    metadata.objectives.some((objective, index) => objective.name !== STAFFING_SOLVER_STAGE_NAMES[index])
  ) {
    invalid("Staffing solver objective metadata must use the fixed stage order");
  }
  if (
    status === "OPTIMAL" &&
    (metadata.objectives.length !== STAFFING_SOLVER_STAGE_NAMES.length ||
      metadata.objectives.some((objective) => objective.value !== objective.bestBound))
  ) {
    invalid("Staffing solver OPTIMAL result is not proven by its objective bounds");
  }
  if (status === "FEASIBLE" && metadata.objectives.length === 0) {
    invalid("Staffing solver FEASIBLE result has no completed objective stage");
  }
  if (
    (status === "INFEASIBLE" || status === "MODEL_INVALID") &&
    metadata.objectives.length !== 0
  ) {
    invalid(`Staffing solver ${status} result must not report objective stages`);
  }
  const provenObjectives = status === "FEASIBLE"
    ? metadata.objectives.slice(0, -1)
    : metadata.objectives;
  if (provenObjectives.some((objective) => objective.value !== objective.bestBound)) {
    invalid("Staffing solver completed objective stages are not proven by their bounds");
  }
  return metadata as StaffingSolverMetadata;
}

function verifyObjectiveEvidence(
  metadata: StaffingSolverMetadata,
  status: "OPTIMAL" | "FEASIBLE",
  metrics: StaffingProposalMetrics,
  plan: ProjectState,
  problem: StaffingProblemV1,
): void {
  const projectStart = problem.current.projectStart;
  const finishDayIndex = Math.round(
    (new Date(`${metrics.finish}T00:00:00.000Z`).getTime() -
      new Date(`${projectStart}T00:00:00.000Z`).getTime()) /
      DAY_MILLISECONDS,
  );
  const assignmentUnits = new Map(plan.assignments.map((assignment) => [
    `${assignment.taskId}\u0000${assignment.resourceId}`,
    assignment.unitsPercent,
  ]));
  const taskIds = problem.tasks.map((task) => task.id).sort();
  const resourceIds = [...problem.current.resources, ...problem.candidateResources]
    .map((resource) => resource.id).sort();
  const stableAssignmentScore = taskIds.flatMap((taskId) =>
    resourceIds.map((resourceId) => `${taskId}\u0000${resourceId}`))
    .reduce((total, key, index) => total + (index + 1) * (assignmentUnits.get(key) ?? 0), 0);
  const plannedActivities = new Map(schedule(plan).activities.map((activity) => [activity.id, activity]));
  const stableStartScore = taskIds.reduce((total, taskId, index) => {
    const activity = plannedActivities.get(taskId);
    if (activity === undefined) invalid(`Verified plan omitted staffing Task: ${taskId}`);
    const startDayIndex = Math.round(
      (new Date(`${activity.earlyStart}T00:00:00.000Z`).getTime() -
        new Date(`${projectStart}T00:00:00.000Z`).getTime()) /
        DAY_MILLISECONDS,
    );
    return total + (index + 1) * startDayIndex;
  }, 0);
  const expectedValues = [
    finishDayIndex,
    metrics.overtimeMinutes * 100,
    Math.round(metrics.plannedLaborCostMinor * 60 * 100),
    metrics.assignmentChanges,
    metrics.scheduleChanges,
    metrics.candidateResources,
    stableAssignmentScore,
    stableStartScore,
  ] as const;
  if (status === "OPTIMAL" && metadata.objectives.length !== STAFFING_SOLVER_STAGE_NAMES.length) {
    invalid("Staffing solver OPTIMAL result omitted objective evidence");
  }
  for (let index = 0; index < metadata.objectives.length; index += 1) {
    const objective = metadata.objectives[index]!;
    if (objective.name !== STAFFING_SOLVER_STAGE_NAMES[index] || objective.value !== expectedValues[index]) {
      invalid("Staffing solver objective evidence does not match the verified plan");
    }
  }
}

function schedule(project: ProjectState): ScheduleResult {
  return calculateSchedule({
    projectStart: project.projectStart,
    defaultCalendarId: project.defaultCalendarId,
    calendars: project.calendars,
    activities: project.tasks.map((task) => ({
      id: task.id,
      durationWorkingDays: task.durationWorkingDays,
      calendarId: task.calendarId,
      dependencies: task.dependencies,
      ...(task.constraint === null ? {} : { constraint: task.constraint }),
    })),
  });
}

function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateLimit(value: number | null, label: string, integer: boolean): void {
  if (value === null) return;
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    invalid(`${label} must be a safe non-negative${integer ? " integer" : " number"}`);
  }
}

function validateRequest(request: StaffingProposalRequest, current: ProjectState): StaffingProblemV1 {
  if (!/^(0|[1-9][0-9]*)$/.test(request.currentRevision)) invalid("Current revision is invalid");
  if (request.constraints.version !== "staffing-constraints-v1") invalid("Staffing constraints version is unsupported");
  if (request.objective.version !== "staffing-objective-v1") invalid("Staffing objective version is unsupported");
  if (request.constraints.deadline !== null && !validDate(request.constraints.deadline)) {
    invalid("Staffing deadline is invalid");
  }
  validateLimit(request.constraints.maxPlannedLaborCostMinor, "Cost ceiling", true);
  validateLimit(request.constraints.maxOvertimeMinutes, "Overtime ceiling", false);
  validateLimit(request.constraints.maxAssignmentChanges, "Assignment change cap", true);
  validateLimit(request.constraints.maxScheduleChanges, "Schedule change cap", true);
  validateLimit(request.constraints.maxCandidateResources, "Candidate Resource cap", true);
  if ((request.constraints.maxPlannedLaborCostMinor ?? 0) > 1_000_000_000_000_000) {
    invalid("Cost ceiling exceeds the staffing model limit");
  }
  if ((request.constraints.maxOvertimeMinutes ?? 0) > 10_000_000) {
    invalid("Overtime ceiling exceeds the staffing model limit");
  }
  if ((request.constraints.maxAssignmentChanges ?? 0) > 10_000) {
    invalid("Assignment change cap exceeds the staffing model limit");
  }
  if ((request.constraints.maxScheduleChanges ?? 0) > 100) {
    invalid("Schedule change cap exceeds the staffing model limit");
  }
  if (request.constraints.requireSkillCoverage !== true) invalid("Skill coverage must be a hard constraint");
  if (
    request.objective.priorities.length !== STAFFING_OBJECTIVE_PRIORITIES.length ||
    request.objective.priorities.some((priority, index) => priority !== STAFFING_OBJECTIVE_PRIORITIES[index])
  ) {
    invalid("Staffing objective priorities must use the fixed verified order");
  }

  // Reuse the Project command boundary to validate every input entity and Project invariant.
  applyProjectCommand(current, { type: "baseline.publish", label: "Staffing input validation" });
  const candidateResources = request.candidateResources ?? [];
  if (candidateResources.length > 100) invalid("Staffing input cannot contain more than 100 candidate Resources");
  let candidateValidationProject = current;
  for (const resource of candidateResources) {
    try {
      candidateValidationProject = applyProjectCommand(candidateValidationProject, {
        type: "resource.add",
        resource,
      });
    } catch (error) {
      invalid(error instanceof Error ? error.message : "Candidate Resource is invalid");
    }
  }
  const unfinished = current.tasks.filter((task) => task.progressPercent < 100);
  if (unfinished.length === 0) invalid("Staffing input requires at least one unfinished Task");
  if (unfinished.length > 100) invalid("Staffing input cannot contain more than 100 unfinished Tasks");
  if (current.resources.length + candidateResources.length > 100) {
    invalid("Staffing input cannot contain more than 100 total Resources");
  }
  if ([...current.resources, ...candidateResources].some((resource) =>
    resource.costRateMinorPerHour > 100_000_000 || resource.skillIds.length > 256)) {
    invalid("Staffing Resource exceeds the optimization model limits");
  }
  if (unfinished.some((task) =>
    task.durationWorkingDays > 366 || task.requiredSkillIds.length > 64 || task.dependencies.length > 100)) {
    invalid("Staffing Task exceeds the optimization model limits");
  }
  const horizonEnd = new Date(`${current.projectStart}T00:00:00.000Z`);
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 365);
  const horizonEndText = horizonEnd.toISOString().slice(0, 10);
  const currentSchedule = schedule(current);
  const calendarById = new Map(current.calendars.map((calendar) => [calendar.id, calendar]));
  if (currentSchedule.activities.some((activity) => {
    const task = unfinished.find((candidate) => candidate.id === activity.id);
    const calendar = task === undefined ? undefined : calendarById.get(task.calendarId);
    return task !== undefined && (
      activity.earlyStart > horizonEndText ||
      calendar === undefined ||
      !calendarWorksOn(new Date(`${activity.earlyStart}T00:00:00.000Z`), calendar)
    );
  })) {
    invalid("Staffing input exceeds the 366-day optimization horizon");
  }
  if (request.constraints.deadline !== null && request.constraints.deadline > horizonEndText) {
    invalid("Staffing deadline exceeds the 366-day optimization horizon");
  }
  const unfinishedIds = new Set(unfinished.map((task) => task.id));
  const byTask = new Map<string, ConfirmedRemainingEffort>();
  for (const effort of request.remainingEffort) {
    if (
      !unfinishedIds.has(effort.taskId) ||
      byTask.has(effort.taskId) ||
      effort.provenance !== "HUMAN_CONFIRMED" ||
      !Number.isSafeInteger(effort.remainingEffortMinutes) ||
      effort.remainingEffortMinutes <= 0 ||
      effort.remainingEffortMinutes > 10_000_000 ||
      !Number.isSafeInteger(effort.maxParallelResources) ||
      effort.maxParallelResources < 1 ||
      effort.maxParallelResources > 10
    ) {
      throw new StaffingProposalValidationError(
        "Every unfinished Task requires positive, safe, human-confirmed remaining effort and maximum parallel Resources",
        "MISSING_REMAINING_EFFORT",
      );
    }
    byTask.set(effort.taskId, effort);
  }
  if (byTask.size !== unfinished.length) {
    throw new StaffingProposalValidationError(
      "Every unfinished Task requires positive, safe, human-confirmed remaining effort and maximum parallel Resources",
      "MISSING_REMAINING_EFFORT",
    );
  }

  return {
    version: "staffing-problem-v1",
    sourceProjectRevision: request.currentRevision,
    current,
    tasks: unfinished.map((task) => ({
      id: task.id,
      remainingEffortMinutes: byTask.get(task.id)!.remainingEffortMinutes,
      maxParallelResources: byTask.get(task.id)!.maxParallelResources,
      remainingEffortProvenance: "HUMAN_CONFIRMED",
    })),
    candidateResources: candidateResources.map((resource) => ({ ...resource, skillIds: [...resource.skillIds] })),
    constraints: request.constraints,
    objective: request.objective,
  };
}

export function validateStaffingProposalRequest(request: StaffingProposalRequest): StaffingProblemV1 {
  const current = structuredClone(request.current);
  return validateRequest(request, current);
}

function assignmentsByTask(assignments: readonly ProjectAssignment[]): ReadonlyMap<string, readonly ProjectAssignment[]> {
  const result = new Map<string, ProjectAssignment[]>();
  for (const assignment of assignments) {
    const entries = result.get(assignment.taskId) ?? [];
    entries.push({ ...assignment });
    result.set(assignment.taskId, entries);
  }
  for (const entries of result.values()) {
    entries.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  }
  return result;
}

function sameAssignments(left: readonly ProjectAssignment[], right: readonly ProjectAssignment[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined && entry.resourceId === candidate.resourceId && entry.unitsPercent === candidate.unitsPercent;
  });
}

function planChanges(
  current: ProjectState,
  candidates: readonly ProjectResource[],
  result: StaffingSolvedResult,
): readonly ScenarioPlanCommand[] {
  const taskIds = new Set(current.tasks.map((task) => task.id));
  const currentResourceIds = new Set(current.resources.map((resource) => resource.id));
  const candidateById = new Map(candidates.map((resource) => [resource.id, resource]));
  const selectedCandidateIds = new Set<string>();
  for (const resourceId of result.selectedCandidateResourceIds) {
    if (!candidateById.has(resourceId)) invalid(`Solver selected an unknown candidate Resource: ${resourceId}`);
    if (selectedCandidateIds.has(resourceId)) invalid(`Solver selected a duplicate candidate Resource: ${resourceId}`);
    selectedCandidateIds.add(resourceId);
  }
  const resourceIds = new Set([...currentResourceIds, ...selectedCandidateIds]);
  const assignmentKeys = new Set<string>();
  for (const assignment of result.assignments) {
    if (!taskIds.has(assignment.taskId)) invalid(`Solver returned an unknown task: ${assignment.taskId}`);
    if (!resourceIds.has(assignment.resourceId)) invalid(`Solver returned an unknown resource: ${assignment.resourceId}`);
    const key = `${assignment.taskId}\u0000${assignment.resourceId}`;
    if (assignmentKeys.has(key)) invalid("Solver returned duplicate Assignments");
    assignmentKeys.add(key);
  }
  const currentAssignments = assignmentsByTask(current.assignments);
  const nextAssignments = assignmentsByTask(result.assignments);
  const changes: ScenarioPlanCommand[] = [...selectedCandidateIds].map((resourceId) => ({
    type: "resource.add" as const,
    resource: candidateById.get(resourceId)!,
  }));
  for (const task of current.tasks) {
    const before = currentAssignments.get(task.id) ?? [];
    const after = nextAssignments.get(task.id) ?? [];
    if (task.progressPercent === 100 && !sameAssignments(before, after)) {
      invalid(`Solver cannot change completed Task Assignments: ${task.id}`);
    }
    if (!sameAssignments(before, after)) {
      changes.push({
        type: "assignment.replace",
        taskId: task.id,
        assignments: after.map(({ resourceId, unitsPercent }) => ({ resourceId, unitsPercent })),
      });
    }
  }

  const updates = new Map<string, { durationWorkingDays?: number; constraint?: { type: "MUST_START_ON"; date: string } }>();
  const durations = new Map<string, number>();
  const unfinished = current.tasks.filter((task) => task.progressPercent < 100);
  const unfinishedIds = new Set(unfinished.map((task) => task.id));
  for (const proposed of result.taskDurations) {
    if (!unfinishedIds.has(proposed.taskId)) invalid(`Solver returned a duration for an unknown or completed task: ${proposed.taskId}`);
    if (durations.has(proposed.taskId)) invalid(`Solver returned duplicate Task durations: ${proposed.taskId}`);
    if (
      !Number.isInteger(proposed.durationWorkingDays) ||
      proposed.durationWorkingDays < 1 ||
      proposed.durationWorkingDays > MAX_ACTIVITY_DURATION_WORKING_DAYS
    ) {
      invalid(`Solver returned an invalid Task duration: ${proposed.taskId}`);
    }
    durations.set(proposed.taskId, proposed.durationWorkingDays);
  }
  if (durations.size !== unfinished.length || unfinished.some((task) => !durations.has(task.id))) {
    invalid("Solver must return exactly one duration for every unfinished Task");
  }
  for (const task of unfinished) {
    const durationWorkingDays = durations.get(task.id)!;
    if (durationWorkingDays !== task.durationWorkingDays) updates.set(task.id, { durationWorkingDays });
  }

  const currentSchedule = schedule(current);
  const starts = new Map<string, string>();
  for (const proposed of result.taskStarts ?? []) {
    if (!unfinishedIds.has(proposed.taskId)) invalid(`Solver returned a start for an unknown or completed task: ${proposed.taskId}`);
    if (starts.has(proposed.taskId)) invalid(`Solver returned duplicate Task starts: ${proposed.taskId}`);
    if (!validDate(proposed.start)) invalid(`Solver returned an invalid Task start: ${proposed.start}`);
    starts.set(proposed.taskId, proposed.start);
  }
  for (const [taskId, proposed] of starts) {
    const task = current.tasks.find((candidate) => candidate.id === taskId)!;
    const existing = currentSchedule.activities.find((activity) => activity.id === task.id)?.earlyStart;
    if (existing === undefined) invalid(`Current schedule omitted Task: ${task.id}`);
    if (proposed === existing) continue;
    if (task.constraint !== null) invalid(`Solver cannot replace the existing constraint for Task: ${task.id}`);
    updates.set(task.id, {
      ...updates.get(task.id),
      constraint: { type: "MUST_START_ON", date: proposed },
    });
  }
  for (const task of unfinished) {
    const taskChanges = updates.get(task.id);
    if (taskChanges === undefined) continue;
    changes.push({
      type: "task.update",
      taskId: task.id,
      changes: taskChanges,
    });
  }
  return changes;
}

const ALLOWED_STAFFING_UNITS = new Set([25, 50, 75, 100]);
const DAY_MILLISECONDS = 86_400_000;

function calendarWorksOn(
  value: Date,
  calendar: { readonly workingWeekdays: readonly number[]; readonly nonWorkingDates: readonly string[] },
): boolean {
  const javascriptDay = value.getUTCDay();
  const isoWeekday = javascriptDay === 0 ? 7 : javascriptDay;
  const date = value.toISOString().slice(0, 10);
  return calendar.workingWeekdays.includes(isoWeekday) && !calendar.nonWorkingDates.includes(date);
}

function verifySolverEffort(
  plan: ProjectState,
  plannedSchedule: ScheduleResult,
  problem: StaffingProblemV1,
): void {
  const activities = new Map(plannedSchedule.activities.map((activity) => [activity.id, activity]));
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const resources = new Map(plan.resources.map((resource) => [resource.id, resource]));
  const calendars = new Map(plan.calendars.map((calendar) => [calendar.id, calendar]));
  const assignments = assignmentsByTask(plan.assignments);

  for (const required of problem.tasks) {
    const taskAssignments = assignments.get(required.id) ?? [];
    if (taskAssignments.length > required.maxParallelResources) {
      invalid(`Solver exceeded maximum parallel Resources for Task: ${required.id}`);
    }
    if (taskAssignments.some((assignment) => !ALLOWED_STAFFING_UNITS.has(assignment.unitsPercent))) {
      invalid(`Solver returned unsupported assignment units for Task: ${required.id}`);
    }

    const task = tasks.get(required.id);
    const activity = activities.get(required.id);
    const taskCalendar = task === undefined ? undefined : calendars.get(task.calendarId);
    if (task === undefined || activity === undefined || taskCalendar === undefined) {
      invalid(`Verified plan omitted staffing Task: ${required.id}`);
    }

    let suppliedMinutes = 0;
    for (const assignment of taskAssignments) {
      const resource = resources.get(assignment.resourceId);
      const resourceCalendar = resource === undefined ? undefined : calendars.get(resource.calendarId);
      if (resource === undefined || resourceCalendar === undefined) {
        invalid(`Verified plan omitted assigned Resource: ${assignment.resourceId}`);
      }
      const finish = new Date(`${activity.earlyFinish}T00:00:00.000Z`).getTime();
      for (
        let cursor = new Date(`${activity.earlyStart}T00:00:00.000Z`);
        cursor.getTime() <= finish;
        cursor = new Date(cursor.getTime() + DAY_MILLISECONDS)
      ) {
        if (calendarWorksOn(cursor, taskCalendar) && calendarWorksOn(cursor, resourceCalendar)) {
          suppliedMinutes += (resource.dailyCapacityMinutes * assignment.unitsPercent) / 100;
        }
      }
    }
    if (suppliedMinutes < required.remainingEffortMinutes) {
      invalid(`Solver plan does not cover confirmed remaining effort for Task: ${required.id}`);
    }
  }
}

function verifiedMetrics(
  current: ProjectState,
  plan: ProjectState,
  changes: readonly ScenarioPlanCommand[],
  problem: StaffingProblemV1,
): StaffingProposalMetrics {
  const constraints = problem.constraints;
  const plannedSchedule = schedule(plan);
  const violated = plannedSchedule.activities.find((activity) => activity.constraintViolation !== undefined);
  if (violated !== undefined) invalid(`Proposed schedule violates the constraint for Task: ${violated.id}`);
  verifySolverEffort(plan, plannedSchedule, problem);
  const capacity = calculateProjectCapacity(plan, plannedSchedule);
  const plannedLaborCostMinor = capacity.resources.reduce(
    (total, resource) => total + resource.plannedLaborCostMinor,
    0,
  );
  const overtimeMinutes = capacity.resources.reduce(
    (total, resource) => total + resource.overallocatedMinutes,
    0,
  );
  const beforeAssignments = new Map(current.assignments.map((assignment) => [
    `${assignment.taskId}\u0000${assignment.resourceId}`,
    assignment.unitsPercent,
  ]));
  const afterAssignments = new Map(plan.assignments.map((assignment) => [
    `${assignment.taskId}\u0000${assignment.resourceId}`,
    assignment.unitsPercent,
  ]));
  const assignmentChanges = new Set([...beforeAssignments.keys(), ...afterAssignments.keys()]).size === 0
    ? 0
    : [...new Set([...beforeAssignments.keys(), ...afterAssignments.keys()])].filter(
      (key) => beforeAssignments.get(key) !== afterAssignments.get(key),
    ).length;
  const scheduleChanges = changes.filter((change) => change.type === "task.update").length;
  const candidateResources = changes.filter((change) => change.type === "resource.add").length;
  if (constraints.deadline !== null && plannedSchedule.projectFinish > constraints.deadline) {
    invalid(`Proposed finish ${plannedSchedule.projectFinish} exceeds the deadline ${constraints.deadline}`);
  }
  if (
    constraints.maxPlannedLaborCostMinor !== null &&
    plannedLaborCostMinor > constraints.maxPlannedLaborCostMinor
  ) {
    invalid("Proposed planned labor cost exceeds the cost ceiling");
  }
  if (constraints.maxOvertimeMinutes !== null && overtimeMinutes > constraints.maxOvertimeMinutes) {
    invalid("Proposed over-allocation exceeds the overtime ceiling");
  }
  if (constraints.maxAssignmentChanges !== null && assignmentChanges > constraints.maxAssignmentChanges) {
    invalid("Proposed Assignments exceed the assignment change cap");
  }
  if (constraints.maxScheduleChanges !== null && scheduleChanges > constraints.maxScheduleChanges) {
    invalid("Proposed starts exceed the schedule change cap");
  }
  if (candidateResources > constraints.maxCandidateResources) {
    invalid("Proposed Resources exceed the candidate Resource cap");
  }
  if (constraints.requireSkillCoverage && capacity.skillGapActivityIds.length > 0) {
    invalid("Proposed Assignments do not satisfy required Skill coverage");
  }
  // Confirm the immutable source is not accidentally used as the proposed plan.
  if (plan.id !== current.id) invalid("Proposed plan belongs to a different Project");
  return {
    finish: plannedSchedule.projectFinish,
    plannedLaborCostMinor,
    overtimeMinutes,
    assignmentChanges,
    scheduleChanges,
    candidateResources,
    skillGapTaskIds: [...capacity.skillGapActivityIds],
    capacity,
  };
}

function explanationInput(
  metrics: StaffingProposalMetrics,
  changes: readonly ScenarioPlanCommand[],
  diagnostics: readonly StaffingSolverDiagnostic[],
): StaffingExplanationInput {
  return {
    facts: [
      `Verified finish: ${metrics.finish}`,
      `Verified planned labor cost: ${metrics.plannedLaborCostMinor}`,
      `Verified overtime minutes: ${metrics.overtimeMinutes}`,
      `Verified assignment changes: ${metrics.assignmentChanges}`,
      `Verified schedule changes: ${metrics.scheduleChanges}`,
      `Verified candidate Resources: ${metrics.candidateResources}`,
      `Verified plan change count: ${changes.length}`,
      ...diagnostics.map((diagnostic) => `Verified solver diagnostic: ${diagnostic.constraint}`),
    ],
    changeDescriptions: changes.map((change) => JSON.stringify(change)),
  };
}

const CLAIM_TOKEN = /\b(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z][A-Za-z0-9._:-]*\d[A-Za-z0-9._:-]*|\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?)\b/gi;
const ENTITY_REFERENCE = /\b(?:assign(?:ed)?(?:\s+to)?|task|resource|skill|candidate|predecessor|successor)\s*[:#]?\s+([A-Za-z][A-Za-z0-9._:-]*)/gi;

function claimTokens(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.flatMap((value) => value.match(CLAIM_TOKEN) ?? []).map((value) => value.toLowerCase()));
}

function entityReferences(values: readonly string[]): readonly string[] {
  return values.flatMap((value) => [...value.matchAll(ENTITY_REFERENCE)].map((match) => match[1]!.toLowerCase()));
}

export function staffingExplanationFallback(input: StaffingExplanationInput): StaffingExplanation {
  return {
    summary: "The proposal satisfies the verified staffing constraints shown below.",
    details: [
      ...input.facts,
      ...(input.changeDescriptions.length === 0
        ? ["No plan changes are required."]
        : [`The verified plan contains ${input.changeDescriptions.length} changes.`]),
    ],
  };
}

function verifiedExplanation(
  input: StaffingExplanationInput,
  value: StaffingExplanation,
): StaffingExplanation {
  const fallback = staffingExplanationFallback(input);
  if (
    typeof value.summary !== "string" || value.summary.trim().length === 0 || value.summary.length > 600 ||
    !Array.isArray(value.details) || value.details.length > 8 ||
    value.details.some((detail) => typeof detail !== "string" || detail.trim().length === 0 || detail.length > 500)
  ) return fallback;
  const trustedClaims = new Set([...input.facts, ...input.changeDescriptions]);
  const trustedText = [...trustedClaims].join(" ").toLowerCase();
  if (claimTokens([value.summary]).size > 0) return fallback;
  if (entityReferences([value.summary, ...value.details]).some((reference) =>
    !trustedText.includes(reference))) return fallback;
  if (value.details.some((detail) =>
    claimTokens([detail]).size > 0 && !trustedClaims.has(detail.trim()))) return fallback;
  return {
    summary: value.summary.trim(),
    details: value.details.map((detail) => detail.trim()),
  };
}

export function createStaffingProposalService(dependencies: {
  readonly optimizer: StaffingOptimizer;
  readonly explainer: StaffingExplainer;
}): StaffingProposalService {
  return {
    async generate(request) {
      const problem = validateStaffingProposalRequest(request);
      const current = problem.current;
      const solverResult = await dependencies.optimizer.solve(structuredClone(problem));
      if (solverResult.version !== "staffing-solver-result-v1") invalid("Staffing solver result version is unsupported");
      if (!(["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN", "MODEL_INVALID"] as const).includes(solverResult.status)) {
        invalid("Staffing solver status is unsupported");
      }
      if (solverResult.sourceProjectRevision !== problem.sourceProjectRevision) {
        invalid("Staffing solver result revision does not match Current revision");
      }
      const solverMetadata = validatedSolverMetadata(solverResult.metadata, solverResult.status);
      const diagnostics = solverResult.diagnostics.map((diagnostic) => ({
        constraint: String(diagnostic.constraint),
        message: String(diagnostic.message),
      }));
      if (solverResult.status !== "OPTIMAL" && solverResult.status !== "FEASIBLE") {
        return { status: solverResult.status, problem, diagnostics, solverMetadata };
      }
      const changes = planChanges(current, problem.candidateResources, solverResult);
      let plan = current;
      for (const change of changes) {
        try {
          plan = applyProjectCommand(plan, change);
        } catch (error) {
          invalid(error instanceof Error ? error.message : "Solver returned an invalid plan change");
        }
      }
      const metrics = verifiedMetrics(current, plan, changes, problem);
      verifyObjectiveEvidence(solverMetadata, solverResult.status, metrics, plan, problem);
      const explanationFacts = explanationInput(metrics, changes, diagnostics);
      let explanation: StaffingExplanation;
      try {
        explanation = verifiedExplanation(
          explanationFacts,
          await dependencies.explainer.explain(explanationFacts),
        );
      } catch {
        explanation = staffingExplanationFallback(explanationFacts);
      }
      return {
        status: solverResult.status,
        problem,
        changes,
        plan,
        metrics,
        explanation,
        diagnostics,
        solverMetadata,
      };
    },
  };
}
