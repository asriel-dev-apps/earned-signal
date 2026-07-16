import { calculateSchedule, type DependencyType } from "@earned-signal/domain";
import type { ProjectCalendar, ProjectState } from "./project-state.js";
import { applyScenarioPlanChanges, type ScenarioPlanCommand } from "./scenario.js";

export const FORECAST_CONTRACT_VERSION = "forecast.v1" as const;
export const FORECAST_MIN_ITERATIONS = 1_000;
export const FORECAST_MAX_ITERATIONS = 50_000;
export const FORECAST_MAX_TASKS = 100;
export const FORECAST_MAX_HORIZON_CALENDAR_DAYS = 366;

export interface ForecastThreePointEstimate {
  readonly taskId: string;
  readonly optimisticMinutes: number;
  readonly mostLikelyMinutes: number;
  readonly pessimisticMinutes: number;
  readonly provenance: "HUMAN_CONFIRMED";
}

export interface ForecastCorrelationGroupInput {
  readonly id: string;
  readonly taskIds: readonly string[];
  readonly coefficientBasisPoints: number;
}

export interface ForecastStoppingRule {
  readonly minIterations: number;
  readonly maxIterations: number;
  readonly checkEvery: number;
  readonly quantileToleranceBasisPoints: number;
  readonly stableChecks: number;
}

export interface ForecastRequestV1 {
  readonly contractVersion: typeof FORECAST_CONTRACT_VERSION;
  readonly current: ProjectState;
  readonly scenarioChanges: readonly ScenarioPlanCommand[];
  readonly estimates: readonly ForecastThreePointEstimate[];
  readonly correlationGroups: readonly ForecastCorrelationGroupInput[];
  readonly seed: number;
  readonly stopping: ForecastStoppingRule;
  readonly targetDate: string;
}

export interface ForecastProblemV1 {
  readonly contractVersion: typeof FORECAST_CONTRACT_VERSION;
  readonly projectId: string;
  readonly sourceRevision: string;
  readonly completedActualCostMinor: number;
  readonly defaultWorkingDates: readonly string[];
  readonly tasks: readonly ForecastProblemTaskV1[];
  readonly correlationGroups: readonly {
    readonly id: string;
    readonly coefficientBasisPoints: number;
  }[];
  readonly seed: number;
  readonly stopping: ForecastStoppingRule;
  readonly targetFinishDate: string;
}

export interface ForecastProblemTaskV1 {
  readonly id: string;
  readonly workingDates: readonly string[];
  readonly currentStartDate: string;
  readonly dependencies: readonly {
    readonly predecessorTaskId: string;
    readonly type: DependencyType;
    readonly lagWorkingDays: number;
  }[];
  readonly productiveMinutesPerDay: number;
  readonly weightedCostMinorPerHour: number;
  readonly actualCostMinor: number;
  readonly effortEstimate: Omit<ForecastThreePointEstimate, "taskId" | "provenance">;
  readonly correlationGroupId: string | null;
}

export interface ForecastResultV1 {
  readonly contractVersion: typeof FORECAST_CONTRACT_VERSION;
  readonly inputHash: string;
  readonly projectId: string;
  readonly sourceRevision: string;
  readonly iterations: number;
  readonly converged: boolean;
  readonly p50FinishDate: string;
  readonly p80FinishDate: string;
  readonly p50TotalCostMinor: number;
  readonly p80TotalCostMinor: number;
  readonly targetProbabilityBasisPoints: number;
  readonly stoppingCheckpoints: readonly ForecastStoppingCheckpointV1[];
  readonly quantiles: readonly {
    readonly basisPoints: 5000 | 8000;
    readonly finishDate: string;
    readonly totalCostMinor: number;
  }[];
  readonly finishHistogram: readonly { readonly finishDate: string; readonly count: number }[];
  readonly costHistogram: readonly {
    readonly lowerBoundMinor: number;
    readonly upperBoundMinor: number;
    readonly count: number;
  }[];
  readonly metadata: {
    readonly algorithmVersion: "earned-signal-monte-carlo-1";
    readonly runtimeVersion: string;
    readonly seed: number;
    readonly randomGenerator: "mt19937-box-muller-v1";
    readonly distributionMethod: "correlated-normal-cdf-triangular-quantile-v1";
    readonly scheduleMethod: "working-calendar-cpm-v1";
  };
}

export interface ForecastStoppingCheckpointV1 {
  readonly iteration: number;
  readonly p50FinishDate: string;
  readonly p80FinishDate: string;
  readonly p50TotalCostMinor: number;
  readonly p80TotalCostMinor: number;
}

export class ForecastValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForecastValidationError";
  }
}

function fail(message: string): never {
  throw new ForecastValidationError(message);
}

function parseDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${field} must be an ISO date`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) fail(`${field} must be an ISO date`);
  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.valueOf() + days * 86_400_000);
}

function isWorkingDate(calendar: ProjectCalendar, date: Date): boolean {
  const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  return calendar.workingWeekdays.includes(weekday) && !calendar.nonWorkingDates.includes(isoDate(date));
}

function wholeNumber(value: number, min: number, max: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${field} must be a whole number from ${min} to ${max}`);
}

function identifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(`${field} must be a valid Forecast identifier`);
}

function validateStopping(stopping: ForecastStoppingRule): void {
  wholeNumber(stopping.minIterations, FORECAST_MIN_ITERATIONS, FORECAST_MAX_ITERATIONS, "Minimum iterations");
  wholeNumber(stopping.maxIterations, FORECAST_MIN_ITERATIONS, FORECAST_MAX_ITERATIONS, "Maximum iterations");
  if (stopping.maxIterations < stopping.minIterations) fail("Maximum iterations must not be below minimum iterations");
  wholeNumber(stopping.checkEvery, 100, 5_000, "Stopping check interval");
  if (stopping.minIterations % stopping.checkEvery !== 0 || stopping.maxIterations % stopping.checkEvery !== 0) fail("Iteration bounds must be multiples of the stopping check interval");
  wholeNumber(stopping.quantileToleranceBasisPoints, 0, 10_000, "Quantile tolerance");
  wholeNumber(stopping.stableChecks, 1, 100, "Stable checks");
  if (stopping.stableChecks > (stopping.maxIterations - stopping.minIterations) / stopping.checkEvery) fail("Stable checks cannot be reached before maximum iterations");
}

function validateRequest(request: ForecastRequestV1): ProjectState {
  if (request.contractVersion !== FORECAST_CONTRACT_VERSION) fail("Unsupported Forecast contract version");
  wholeNumber(request.seed, 0, 0xffff_ffff, "Seed");
  validateStopping(request.stopping);
  const plan = applyScenarioPlanChanges(request.current, request.scenarioChanges);
  identifier(plan.id, "Project ID");
  const statusDate = parseDate(plan.statusDate, "Status date");
  const targetDate = parseDate(request.targetDate, "Target date");
  const horizon = Math.round((targetDate.valueOf() - statusDate.valueOf()) / 86_400_000);
  if (horizon < 0 || horizon > FORECAST_MAX_HORIZON_CALENDAR_DAYS) fail(`Target date must be between the status date and ${FORECAST_MAX_HORIZON_CALENDAR_DAYS} calendar days after it`);
  const unfinished = plan.tasks.filter((task) => task.progressPercent < 100);
  if (unfinished.length === 0 || unfinished.length > FORECAST_MAX_TASKS) fail(`Forecast requires 1 to ${FORECAST_MAX_TASKS} unfinished tasks`);
  const estimates = new Map(request.estimates.map((estimate) => [estimate.taskId, estimate]));
  const unfinishedIds = new Set(unfinished.map((task) => task.id));
  if (estimates.size !== request.estimates.length) fail("Forecast estimate task IDs must be unique");
  if (request.estimates.length !== unfinished.length || request.estimates.some((estimate) => !unfinishedIds.has(estimate.taskId))) fail("Every unfinished task, and only unfinished tasks, requires one estimate");
  for (const estimate of request.estimates) {
    identifier(estimate.taskId, "Estimate task ID");
    if (estimate.provenance !== "HUMAN_CONFIRMED") fail(`Estimate for ${estimate.taskId} must be HUMAN_CONFIRMED`);
    wholeNumber(estimate.optimisticMinutes, 1, 10_000_000, `Optimistic effort for ${estimate.taskId}`);
    wholeNumber(estimate.mostLikelyMinutes, 1, 10_000_000, `Most-likely effort for ${estimate.taskId}`);
    wholeNumber(estimate.pessimisticMinutes, 1, 10_000_000, `Pessimistic effort for ${estimate.taskId}`);
    if (estimate.optimisticMinutes > estimate.mostLikelyMinutes || estimate.mostLikelyMinutes > estimate.pessimisticMinutes) fail(`Estimate for ${estimate.taskId} must satisfy optimistic <= most likely <= pessimistic`);
  }
  const groupedTasks = new Set<string>();
  const groupIds = new Set<string>();
  if (request.correlationGroups.length > 25) fail("Forecast supports at most 25 correlation groups");
  for (const group of request.correlationGroups) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(group.id) || groupIds.has(group.id)) fail("Correlation group IDs must be unique valid identifiers");
    groupIds.add(group.id);
    wholeNumber(group.coefficientBasisPoints, 0, 9_500, `Correlation coefficient for ${group.id}`);
    if (group.taskIds.length < 2 || new Set(group.taskIds).size !== group.taskIds.length) fail(`Correlation group ${group.id} requires at least two unique tasks`);
    for (const taskId of group.taskIds) {
      if (!unfinishedIds.has(taskId)) fail(`Correlation group ${group.id} references unknown unfinished task ${taskId}`);
      if (groupedTasks.has(taskId)) fail(`Task ${taskId} belongs to more than one correlation group`);
      groupedTasks.add(taskId);
    }
  }
  return plan;
}

export function toForecastProblemV1(request: ForecastRequestV1, sourceRevision: bigint | string): ForecastProblemV1 {
  const plan = validateRequest(request);
  const revision = sourceRevision.toString();
  if (!/^\d+$/.test(revision)) fail("Source revision must be a non-negative whole number");
  const statusDate = parseDate(plan.statusDate, "Status date");
  const calendars = new Map(plan.calendars.map((calendar) => [calendar.id, calendar]));
  const resources = new Map(plan.resources.map((resource) => [resource.id, resource]));
  const assignments = new Map<string, typeof plan.assignments>();
  for (const assignment of plan.assignments) assignments.set(assignment.taskId, [...(assignments.get(assignment.taskId) ?? []), assignment]);
  const estimates = new Map(request.estimates.map((estimate) => [estimate.taskId, estimate]));
  const correlationByTask = new Map(request.correlationGroups.flatMap((group) => group.taskIds.map((taskId) => [taskId, group.id] as const)));
  const defaultCalendar = calendars.get(plan.defaultCalendarId);
  if (defaultCalendar === undefined) fail("Project default calendar is unknown");
  const schedule = calculateSchedule({
    projectStart: plan.projectStart,
    defaultCalendarId: plan.defaultCalendarId,
    calendars: plan.calendars,
    activities: plan.tasks.map((task) => ({
      id: task.id,
      durationWorkingDays: task.durationWorkingDays,
      calendarId: task.calendarId,
      dependencies: task.dependencies,
      ...(task.constraint === null ? {} : { constraint: task.constraint }),
    })),
  });
  const scheduledStarts = new Map(schedule.activities.map((activity) => [activity.id, activity.earlyStart]));
  const allDates = Array.from({ length: FORECAST_MAX_HORIZON_CALENDAR_DAYS }, (_, index) => addDays(statusDate, index + 1));
  const defaultWorkingDates = allDates.filter((date) => isWorkingDate(defaultCalendar, date)).map(isoDate);
  const unfinishedIds = new Set(plan.tasks.filter((task) => task.progressPercent < 100).map((task) => task.id));
  const tasks = plan.tasks.filter((task) => task.progressPercent < 100).map((task): ForecastProblemTaskV1 => {
    identifier(task.id, "Task ID");
    const estimate = estimates.get(task.id);
    if (estimate === undefined) fail(`Missing estimate for ${task.id}`);
    const taskCalendar = calendars.get(task.calendarId);
    if (taskCalendar === undefined) fail(`Unknown calendar for task ${task.id}`);
    const taskAssignments = assignments.get(task.id) ?? [];
    if (taskAssignments.length === 0) fail(`Unfinished task ${task.id} requires at least one Resource assignment`);
    const assignedResources = taskAssignments.map((assignment) => {
      const resource = resources.get(assignment.resourceId);
      if (resource === undefined) fail(`Unknown Resource ${assignment.resourceId} assigned to ${task.id}`);
      const calendar = calendars.get(resource.calendarId);
      if (calendar === undefined) fail(`Unknown calendar for Resource ${resource.id}`);
      const capacity = resource.dailyCapacityMinutes * assignment.unitsPercent / 100;
      return { resource, calendar, capacity };
    });
    const productiveMinutesPerDay = assignedResources.reduce((total, item) => total + item.capacity, 0);
    if (!Number.isSafeInteger(productiveMinutesPerDay) || productiveMinutesPerDay < 1 || productiveMinutesPerDay > 144_000) fail(`Productive capacity for ${task.id} must be a whole number from 1 to 144000 minutes`);
    const workingDates = allDates.filter((date) => isWorkingDate(defaultCalendar, date) && isWorkingDate(taskCalendar, date) && assignedResources.every((item) => isWorkingDate(item.calendar, date))).map(isoDate);
    const earliestBoundary = scheduledStarts.get(task.id);
    if (earliestBoundary === undefined) fail(`Schedule is missing unfinished task ${task.id}`);
    const currentStartDate = workingDates.find((date) => date >= earliestBoundary);
    if (currentStartDate === undefined) fail(`Scheduled start for ${task.id} falls outside the forecast horizon`);
    const availableDates = workingDates.length - workingDates.indexOf(currentStartDate);
    if (estimate.pessimisticMinutes > availableDates * productiveMinutesPerDay) fail(`Pessimistic effort for ${task.id} must fit within its productive working dates`);
    const weightedCostMinorPerHour = Math.round(assignedResources.reduce((total, item) => total + item.capacity * item.resource.costRateMinorPerHour, 0) / productiveMinutesPerDay);
    wholeNumber(weightedCostMinorPerHour, 0, 100_000_000, `Weighted cost rate for ${task.id}`);
    wholeNumber(task.actualCost, 0, 1_000_000_000_000_000, `Actual cost for ${task.id}`);
    for (const dependency of task.dependencies) {
      identifier(dependency.predecessorId, `Predecessor ID for ${task.id}`);
      wholeNumber(dependency.lagWorkingDays, 0, 365, `Dependency lag for ${task.id}`);
    }
    return {
      id: task.id,
      workingDates,
      currentStartDate,
      dependencies: task.dependencies.filter((dependency) => unfinishedIds.has(dependency.predecessorId)).map((dependency) => ({ predecessorTaskId: dependency.predecessorId, type: dependency.type, lagWorkingDays: dependency.lagWorkingDays })),
      productiveMinutesPerDay,
      weightedCostMinorPerHour,
      actualCostMinor: task.actualCost,
      effortEstimate: { optimisticMinutes: estimate.optimisticMinutes, mostLikelyMinutes: estimate.mostLikelyMinutes, pessimisticMinutes: estimate.pessimisticMinutes },
      correlationGroupId: correlationByTask.get(task.id) ?? null,
    };
  });
  const completedActualCostMinor = plan.tasks.filter((task) => task.progressPercent === 100).reduce((total, task) => total + task.actualCost, 0);
  if (!Number.isSafeInteger(completedActualCostMinor) || completedActualCostMinor > 1_000_000_000_000_000) fail("Completed actual cost exceeds the Forecast contract range");
  const pessimisticTotalCostMinor = tasks.reduce((total, task) => total + task.actualCostMinor + Math.ceil(task.effortEstimate.pessimisticMinutes * task.weightedCostMinorPerHour / 60), completedActualCostMinor);
  if (!Number.isSafeInteger(pessimisticTotalCostMinor) || pessimisticTotalCostMinor > 1_000_000_000_000_000) fail(`Pessimistic total cost ${pessimisticTotalCostMinor} exceeds the Forecast contract range`);
  return {
    contractVersion: FORECAST_CONTRACT_VERSION,
    projectId: plan.id,
    sourceRevision: revision,
    completedActualCostMinor,
    defaultWorkingDates,
    tasks,
    correlationGroups: request.correlationGroups.map(({ id, coefficientBasisPoints }) => ({ id, coefficientBasisPoints })),
    seed: request.seed,
    stopping: request.stopping,
    targetFinishDate: request.targetDate,
  };
}

function countHistogram(entries: readonly { readonly count: number }[], iterations: number, field: string): void {
  if (entries.length === 0 || entries.length > 366) fail(`${field} histogram requires 1 to 366 bins`);
  let total = 0;
  for (const entry of entries) {
    wholeNumber(entry.count, 0, iterations, `${field} histogram count`);
    total += entry.count;
  }
  if (total !== iterations) fail(`${field} histogram counts must equal the iteration count`);
}

function quantileBin<T extends { readonly count: number }>(entries: readonly T[], iterations: number, basisPoints: 5000 | 8000): T {
  const rank = Math.ceil(iterations * basisPoints / 10_000);
  let cumulative = 0;
  for (const entry of entries) {
    cumulative += entry.count;
    if (cumulative >= rank) return entry;
  }
  fail(`Forecast histogram is missing the P${basisPoints / 100} rank`);
}

function checkpointStable(current: ForecastStoppingCheckpointV1, previous: ForecastStoppingCheckpointV1, problem: ForecastProblemV1): boolean {
  const dateIndices = new Map(problem.defaultWorkingDates.map((value, index) => [value, index]));
  const currentP50 = dateIndices.get(current.p50FinishDate);
  const currentP80 = dateIndices.get(current.p80FinishDate);
  const previousP50 = dateIndices.get(previous.p50FinishDate);
  const previousP80 = dateIndices.get(previous.p80FinishDate);
  if (currentP50 === undefined || currentP80 === undefined || previousP50 === undefined || previousP80 === undefined) fail("Stopping checkpoint finish dates must use the Forecast working-date horizon");
  const pairs = [[currentP50, previousP50], [currentP80, previousP80], [current.p50TotalCostMinor, previous.p50TotalCostMinor], [current.p80TotalCostMinor, previous.p80TotalCostMinor]] as const;
  return pairs.every(([now, before]) => Math.abs(now - before) * 10_000 <= problem.stopping.quantileToleranceBasisPoints * Math.max(Math.abs(before), 1));
}

export function validateForecastResultV1(value: ForecastResultV1, problem: ForecastProblemV1, expectedInputHash: string): ForecastResultV1 {
  if (!/^[0-9a-f]{64}$/.test(expectedInputHash) || value.inputHash !== expectedInputHash) fail("Forecast result does not match the exact hashed input");
  if (value.contractVersion !== FORECAST_CONTRACT_VERSION || value.projectId !== problem.projectId || value.sourceRevision !== problem.sourceRevision) fail("Forecast result does not match the revision-pinned request");
  wholeNumber(value.iterations, problem.stopping.minIterations, problem.stopping.maxIterations, "Forecast iteration count");
  if (value.iterations % problem.stopping.checkEvery !== 0) fail("Forecast iteration count must align with the stopping check interval");
  if (!value.converged && value.iterations !== problem.stopping.maxIterations) fail("A non-converged Forecast must reach maximum iterations");
  const p50Finish = parseDate(value.p50FinishDate, "P50 finish");
  const p80Finish = parseDate(value.p80FinishDate, "P80 finish");
  if (p80Finish < p50Finish) fail("P80 finish must not precede P50 finish");
  wholeNumber(value.p50TotalCostMinor, 0, 1_000_000_000_000_000, "P50 total cost");
  wholeNumber(value.p80TotalCostMinor, 0, 1_000_000_000_000_000, "P80 total cost");
  if (value.p80TotalCostMinor < value.p50TotalCostMinor) fail("P80 cost must not be below P50 cost");
  wholeNumber(value.targetProbabilityBasisPoints, 0, 10_000, "Target probability");
  const expectedCheckpointCount = (value.iterations - problem.stopping.minIterations) / problem.stopping.checkEvery + 1;
  if (!Number.isInteger(expectedCheckpointCount) || value.stoppingCheckpoints.length !== expectedCheckpointCount) fail("Forecast stopping checkpoints must cover every configured check interval");
  let previousCheckpoint: ForecastStoppingCheckpointV1 | null = null;
  let stableChecks = 0;
  let convergenceIteration: number | null = null;
  value.stoppingCheckpoints.forEach((checkpoint, index) => {
    if (checkpoint.iteration !== problem.stopping.minIterations + index * problem.stopping.checkEvery) fail("Forecast stopping checkpoint iterations are invalid");
    const p50Finish = parseDate(checkpoint.p50FinishDate, "Stopping P50 finish");
    const p80Finish = parseDate(checkpoint.p80FinishDate, "Stopping P80 finish");
    if (p80Finish < p50Finish) fail("Stopping P80 finish must not precede P50 finish");
    wholeNumber(checkpoint.p50TotalCostMinor, 0, 1_000_000_000_000_000, "Stopping P50 total cost");
    wholeNumber(checkpoint.p80TotalCostMinor, checkpoint.p50TotalCostMinor, 1_000_000_000_000_000, "Stopping P80 total cost");
    stableChecks = previousCheckpoint !== null && checkpointStable(checkpoint, previousCheckpoint, problem) ? stableChecks + 1 : 0;
    if (stableChecks >= problem.stopping.stableChecks && convergenceIteration === null) convergenceIteration = checkpoint.iteration;
    previousCheckpoint = checkpoint;
  });
  const lastCheckpoint = value.stoppingCheckpoints.at(-1);
  if (lastCheckpoint === undefined || lastCheckpoint.p50FinishDate !== value.p50FinishDate || lastCheckpoint.p80FinishDate !== value.p80FinishDate || lastCheckpoint.p50TotalCostMinor !== value.p50TotalCostMinor || lastCheckpoint.p80TotalCostMinor !== value.p80TotalCostMinor) fail("Final stopping checkpoint must match the Forecast summary");
  if (value.converged ? convergenceIteration !== value.iterations : convergenceIteration !== null) fail("Forecast convergence does not match its consecutive stopping checkpoints");
  if (value.quantiles.length !== 2 || value.quantiles[0]?.basisPoints !== 5000 || value.quantiles[1]?.basisPoints !== 8000) fail("Forecast result requires ordered P50 and P80 quantiles");
  const expected = [[value.p50FinishDate, value.p50TotalCostMinor], [value.p80FinishDate, value.p80TotalCostMinor]] as const;
  value.quantiles.forEach((quantile, index) => {
    parseDate(quantile.finishDate, `Quantile ${quantile.basisPoints} finish`);
    if (quantile.finishDate !== expected[index]?.[0] || quantile.totalCostMinor !== expected[index]?.[1]) fail("Forecast quantiles must match the summary values");
  });
  let previousDate = "";
  for (const bin of value.finishHistogram) {
    parseDate(bin.finishDate, "Finish histogram date");
    if (bin.finishDate <= previousDate) fail("Finish histogram dates must be strictly ordered");
    previousDate = bin.finishDate;
  }
  countHistogram(value.finishHistogram, value.iterations, "Finish");
  if (quantileBin(value.finishHistogram, value.iterations, 5000).finishDate !== value.p50FinishDate || quantileBin(value.finishHistogram, value.iterations, 8000).finishDate !== value.p80FinishDate) fail("Forecast finish summaries must match the exact histogram quantiles");
  const targetSuccesses = value.finishHistogram.reduce((total, bin) => total + (bin.finishDate <= problem.targetFinishDate ? bin.count : 0), 0);
  const expectedTargetProbability = Math.floor((targetSuccesses * 10_000 + value.iterations / 2) / value.iterations);
  if (value.targetProbabilityBasisPoints !== expectedTargetProbability) fail("Target probability must match the finish histogram");
  let previousUpper = -1;
  for (const bin of value.costHistogram) {
    wholeNumber(bin.lowerBoundMinor, 0, 1_000_000_000_000_000, "Cost histogram lower bound");
    wholeNumber(bin.upperBoundMinor, bin.lowerBoundMinor, 1_000_000_000_000_000, "Cost histogram upper bound");
    if (bin.lowerBoundMinor <= previousUpper) fail("Cost histogram bins must be strictly ordered and non-overlapping");
    previousUpper = bin.upperBoundMinor;
  }
  countHistogram(value.costHistogram, value.iterations, "Cost");
  const p50CostBin = quantileBin(value.costHistogram, value.iterations, 5000);
  const p80CostBin = quantileBin(value.costHistogram, value.iterations, 8000);
  if (value.p50TotalCostMinor < p50CostBin.lowerBoundMinor || value.p50TotalCostMinor > p50CostBin.upperBoundMinor || value.p80TotalCostMinor < p80CostBin.lowerBoundMinor || value.p80TotalCostMinor > p80CostBin.upperBoundMinor) fail("Forecast cost summaries must fall within the histogram quantile bins");
  if (value.metadata.algorithmVersion !== "earned-signal-monte-carlo-1" || value.metadata.seed !== problem.seed || value.metadata.randomGenerator !== "mt19937-box-muller-v1" || value.metadata.distributionMethod !== "correlated-normal-cdf-triangular-quantile-v1" || value.metadata.scheduleMethod !== "working-calendar-cpm-v1" || value.metadata.runtimeVersion.trim().length === 0) fail("Forecast result metadata is invalid or does not match the request");
  return value;
}
