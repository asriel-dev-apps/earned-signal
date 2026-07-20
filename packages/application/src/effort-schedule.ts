import { scheduleEffortDailyPlans } from "@earned-signal/domain";
import { leafTaskIds, type ProjectState } from "./project-state.js";

/**
 * Recompute the daily plan of every **unlocked** task from the deterministic
 * capacity-aware scheduler (ADR 0011 Decision 4; step ④), and return a project
 * with those plans applied. Locked tasks keep their hand-edited plan verbatim.
 *
 * This is the "default is auto-placement" (D17) transform: it keeps M = Σ daily
 * and P/Q (first/last non-zero day) consistent with the effort EVM module. It is
 * applied on the write path after a command is validated, so persistence and the
 * grid projection always agree.
 */
export function applyEffortSchedule(project: ProjectState): ProjectState {
  const leaves = leafTaskIds(project.tasks);
  const result = scheduleEffortDailyPlans({
    projectStart: project.projectStart,
    defaultCalendarId: project.defaultCalendarId,
    calendars: project.calendars.map((calendar) => ({
      id: calendar.id,
      workingWeekdays: calendar.workingWeekdays,
      nonWorkingDates: calendar.nonWorkingDates,
    })),
    members: project.members.map((member) => ({
      id: member.id,
      calendarId: member.calendarId,
      dailyCapacityMinutes: member.dailyCapacityMinutes,
    })),
    tasks: project.tasks.map((task) => ({
      id: task.id,
      sortOrder: task.sortOrder,
      assigneeMemberId: task.assigneeMemberId,
      plannedEffortMinutes: task.plannedEffortMinutes,
      dailyPlan: task.dailyPlan,
      dailyPlanLocked: task.dailyPlanLocked,
      dependencies: task.dependencies,
      isLeaf: leaves.has(task.id),
    })),
  });

  return {
    ...project,
    tasks: project.tasks.map((task) => {
      if (task.dailyPlanLocked) return task;
      const dailyPlan = result.dailyPlans.get(task.id);
      return dailyPlan === undefined ? task : { ...task, dailyPlan };
    }),
  };
}
