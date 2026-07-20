import { scheduleEffortDailyPlans } from "@vecta/domain";
import { leafTaskIds, type ProjectState } from "./project-state.js";

/**
 * One-shot deterministic placement (Design 0003 §C-2). Place the daily plan of
 * the given task ids with the capacity-aware scheduler and return a project with
 * those plans applied; every other task keeps its existing `dailyPlan` verbatim
 * and is treated as a fixed fact (its plan still pre-charges the assignee's
 * capacity ledger and constrains where the placed tasks land).
 *
 * This is the "initial values only" transform: it runs once when subtasks are
 * generated (placing just the new leaf children) and once for the demo baseline
 * (placing every leaf). It is never re-run on subsequent edits — after the first
 * placement every daily/estimate value is hand-edited, and consistency is
 * surfaced as non-blocking validation warnings rather than by overwriting.
 *
 * When `taskIdsToPlace` is omitted every leaf is placed (the full baseline).
 */
export function applyEffortSchedule(
  project: ProjectState,
  taskIdsToPlace?: ReadonlySet<string>,
): ProjectState {
  const leaves = leafTaskIds(project.tasks);
  const shouldPlace = (id: string): boolean =>
    taskIdsToPlace === undefined || taskIdsToPlace.has(id);
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
      // A task outside the place-set is a fixed fact: its existing plan is left
      // untouched but still pre-charges the ledger and anchors dependents.
      fixedDailyPlan: !shouldPlace(task.id),
      dependencies: task.dependencies,
      isLeaf: leaves.has(task.id),
    })),
  });

  return {
    ...project,
    tasks: project.tasks.map((task) => {
      if (!shouldPlace(task.id)) return task;
      const dailyPlan = result.dailyPlans.get(task.id);
      return dailyPlan === undefined ? task : { ...task, dailyPlan };
    }),
  };
}
