import type { ProjectState } from "@earned-signal/application";
import {
  calculateEvm,
  calculateSchedule,
  type EvmResult,
  type ScheduledActivity,
} from "@earned-signal/domain";

export interface ProjectAnalysis {
  readonly scheduleById: ReadonlyMap<string, ScheduledActivity>;
  readonly projectFinish: string;
  readonly baselineFinish: string;
  readonly evm: EvmResult;
}

function schedule(project: ProjectState) {
  return calculateSchedule({
    projectStart: project.projectStart,
    activities: project.tasks.map((task) => ({
      id: task.id,
      durationWorkingDays: task.durationWorkingDays,
      dependencies:
        task.predecessorId === null
          ? []
          : [{ predecessorId: task.predecessorId, lagWorkingDays: 0 }],
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
      return {
        id: task.id,
        measurementMethod: "PHYSICAL_PERCENT" as const,
        baselineBudget: baselineTask?.budget ?? 0,
        baselineStart: baselineActivity.earlyStart,
        baselineFinish: baselineActivity.earlyFinish,
        physicalPercent: task.progressPercent,
        measurementDate: project.statusDate,
        worklogs:
          task.actualCost === 0
            ? []
            : [{ workDate: project.statusDate, minutes: 1, ratePerMinute: task.actualCost }],
      };
    }),
  });

  return {
    scheduleById: currentById,
    projectFinish: currentSchedule.projectFinish,
    baselineFinish: baselineSchedule.projectFinish,
    evm,
  };
}
