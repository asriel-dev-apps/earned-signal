import {
  calculateProjectCapacity,
  type ProjectState,
} from "@earned-signal/application";
import {
  calculateEvm,
  calculateSchedule,
  type EvmResult,
  type CapacityResult,
  type ScheduledActivity,
} from "@earned-signal/domain";

export interface ProjectAnalysis {
  readonly scheduleById: ReadonlyMap<string, ScheduledActivity>;
  readonly projectFinish: string;
  readonly baselineFinish: string;
  readonly evm: EvmResult;
  readonly capacity: CapacityResult;
}

function schedule(project: ProjectState) {
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

export function analyzeProject(
  project: ProjectState,
  baseline: ProjectState,
): ProjectAnalysis {
  const currentSchedule = schedule(project);
  const baselineSchedule = schedule(baseline);
  const currentById = new Map(
    currentSchedule.activities.map((activity) => [activity.id, activity]),
  );
  const baselineById = new Map(
    baselineSchedule.activities.map((activity) => [activity.id, activity]),
  );
  const baselineTasks = new Map(baseline.tasks.map((task) => [task.id, task]));

  const evm = calculateEvm({
    statusDate: project.statusDate,
    workPackages: project.tasks.map((task) => {
      const baselineTask = baselineTasks.get(task.id);
      const baselineActivity = baselineById.get(task.id) ?? currentById.get(task.id);
      if (baselineActivity === undefined) {
        throw new Error(`Task ${task.id} was not scheduled`);
      }
      const measurement =
        task.measurementMethod === "ZERO_HUNDRED"
          ? {
              measurementMethod: task.measurementMethod,
              completed: task.progressPercent === 100,
            }
          : {
              measurementMethod: task.measurementMethod,
              physicalPercent: task.progressPercent,
            };
      return {
        id: task.id,
        baselineBudget: baselineTask?.budget ?? 0,
        baselineStart: baselineActivity.earlyStart,
        baselineFinish: baselineActivity.earlyFinish,
        ...measurement,
        measurementDate: project.statusDate,
        worklogs: [],
        actualCosts:
          task.actualCost === 0
            ? []
            : [{ costDate: project.statusDate, amount: task.actualCost }],
      };
    }),
  });
  const capacity = calculateProjectCapacity(project, currentSchedule);

  return {
    scheduleById: currentById,
    projectFinish: currentSchedule.projectFinish,
    baselineFinish: baselineSchedule.projectFinish,
    evm,
    capacity,
  };
}
