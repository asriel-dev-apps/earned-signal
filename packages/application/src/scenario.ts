import {
  calculateSchedule,
  MAX_ACTIVITY_DURATION_WORKING_DAYS,
  type CapacityResult,
  type ScheduleResult,
} from "@earned-signal/domain";
import {
  applyProjectCommand,
  calculateProjectCapacity,
  type AddResourceCommand,
  type AddTaskCommand,
  type DeleteResourceCommand,
  type DeleteTaskCommand,
  type ProjectState,
  type ProjectTask,
  type ReplaceTaskAssignmentsCommand,
  type UpdateResourceCommand,
} from "./project-state.js";

export interface ScenarioTaskUpdateCommand {
  readonly type: "task.update";
  readonly taskId: string;
  readonly changes: Partial<
    Omit<ProjectTask, "id" | "progressPercent" | "actualCost" | "actualMinutes">
  >;
}

export type ScenarioPlanCommand =
  | ScenarioTaskUpdateCommand
  | AddTaskCommand
  | DeleteTaskCommand
  | AddResourceCommand
  | UpdateResourceCommand
  | DeleteResourceCommand
  | ReplaceTaskAssignmentsCommand;

export interface ScenarioInput {
  readonly current: ProjectState;
  readonly baseline: ProjectState;
  readonly changes: readonly ScenarioPlanCommand[];
  readonly trend: {
    readonly spi: number | null;
    readonly cpi: number | null;
  };
}

export interface ScenarioResult {
  readonly plan: ProjectState;
  readonly comparison: {
    readonly currentFinish: string;
    readonly currentEac: number;
    readonly currentPlannedLaborCost: number;
    readonly currentCapacity: CapacityResult;
    readonly tasks: readonly ScenarioTaskForecast[];
  };
  readonly factors: {
    readonly schedule: number;
    readonly cost: number;
    readonly scheduleFallback: boolean;
    readonly costFallback: boolean;
  };
  readonly forecast: {
    readonly finish: string;
    readonly eac: number;
    readonly plannedLaborCost: number;
    readonly capacity: CapacityResult;
    readonly tasks: readonly ScenarioTaskForecast[];
  };
  readonly changes: readonly ScenarioPlanCommand[];
}

export interface ScenarioTaskForecast {
  readonly taskId: string;
  readonly start: string;
  readonly finish: string;
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

function effectiveFactor(index: number | null): { readonly value: number; readonly fallback: boolean } {
  if (index === null || !Number.isFinite(index) || index <= 0) {
    return { value: 1, fallback: true };
  }
  const factor = 1 / index;
  return Number.isFinite(factor)
    ? { value: factor, fallback: false }
    : { value: 1, fallback: true };
}

function trendPlan(project: ProjectState, scheduleFactor: number): ProjectState {
  return {
    ...project,
    tasks: project.tasks.map((task) => {
      const completedRatio = task.progressPercent / 100;
      return {
        ...task,
        durationWorkingDays: Math.max(
          1,
          Math.min(
            MAX_ACTIVITY_DURATION_WORKING_DAYS,
            Math.ceil(
              task.durationWorkingDays * completedRatio +
                task.durationWorkingDays * (1 - completedRatio) * scheduleFactor,
            ),
          ),
        ),
      };
    }),
  };
}

function taskForecasts(result: ScheduleResult): readonly ScenarioTaskForecast[] {
  return result.activities.map((activity) => ({
    taskId: activity.id,
    start: activity.earlyStart,
    finish: activity.earlyFinish,
  }));
}

function estimateAtCompletion(project: ProjectState, costFactor: number): number {
  return Math.round(
    project.tasks.reduce((total, task) => {
      const remainingRatio = 1 - task.progressPercent / 100;
      return total + task.actualCost + task.budget * remainingRatio * costFactor;
    }, 0),
  );
}

function plannedLaborCost(capacity: CapacityResult): number {
  return capacity.resources.reduce(
    (total, resource) => total + resource.plannedLaborCostMinor,
    0,
  );
}

function validateScenarioCommand(command: ScenarioPlanCommand): void {
  const commandType = (command as { readonly type: string }).type;
  if (commandType === "baseline.publish") {
    throw new Error("Scenario commands cannot publish a Baseline");
  }
  if (command.type === "task.add") {
    if (
      command.task.progressPercent !== 0 ||
      command.task.actualCost !== 0 ||
      command.task.actualMinutes !== 0
    ) {
      throw new Error("Scenario commands cannot add progress or actuals");
    }
    return;
  }
  if (command.type !== "task.update") return;
  const changedFields = Object.keys(command.changes);
  if (changedFields.length === 0) {
    throw new Error("Scenario task update requires at least one plan change");
  }
  if (
    changedFields.some((field) =>
      field === "progressPercent" || field === "actualCost" || field === "actualMinutes"
    )
  ) {
    throw new Error("Scenario commands cannot change progress or actuals");
  }
}

function validateProject(project: ProjectState): void {
  applyProjectCommand(project, { type: "baseline.publish", label: "Scenario validation" });
}

export function applyScenarioPlanChanges(
  current: ProjectState,
  changes: readonly ScenarioPlanCommand[],
): ProjectState {
  validateProject(current);
  let plan = current;
  for (const command of changes) {
    validateScenarioCommand(command);
    plan = applyProjectCommand(plan, command);
  }
  return plan;
}

export function calculateScenario(input: ScenarioInput): ScenarioResult {
  validateProject(input.current);
  validateProject(input.baseline);
  if (input.current.id !== input.baseline.id) {
    throw new Error("Scenario Current and Baseline must belong to the same project");
  }

  const plan = applyScenarioPlanChanges(input.current, input.changes);

  const scheduleFactor = effectiveFactor(input.trend.spi);
  const costFactor = effectiveFactor(input.trend.cpi);
  const currentForecastPlan = trendPlan(input.current, scheduleFactor.value);
  const forecastPlan = trendPlan(plan, scheduleFactor.value);
  validateProject(currentForecastPlan);
  validateProject(forecastPlan);

  const currentSchedule = schedule(currentForecastPlan);
  const forecastSchedule = schedule(forecastPlan);
  const currentCapacity = calculateProjectCapacity(currentForecastPlan, currentSchedule);
  const forecastCapacity = calculateProjectCapacity(forecastPlan, forecastSchedule);

  return {
    plan,
    comparison: {
      currentFinish: currentSchedule.projectFinish,
      currentEac: estimateAtCompletion(input.current, costFactor.value),
      currentPlannedLaborCost: plannedLaborCost(currentCapacity),
      currentCapacity,
      tasks: taskForecasts(currentSchedule),
    },
    factors: {
      schedule: scheduleFactor.value,
      cost: costFactor.value,
      scheduleFallback: scheduleFactor.fallback,
      costFallback: costFactor.fallback,
    },
    forecast: {
      finish: forecastSchedule.projectFinish,
      eac: estimateAtCompletion(plan, costFactor.value),
      plannedLaborCost: plannedLaborCost(forecastCapacity),
      capacity: forecastCapacity,
      tasks: taskForecasts(forecastSchedule),
    },
    changes: [...input.changes],
  };
}
