export interface FinishToStartDependency {
  readonly predecessorId: string;
  readonly lagWorkingDays: number;
}

export interface ScheduleActivityInput {
  readonly id: string;
  readonly durationWorkingDays: number;
  readonly dependencies: readonly FinishToStartDependency[];
}

export interface ScheduleInput {
  readonly projectStart: string;
  readonly activities: readonly ScheduleActivityInput[];
}

export interface ScheduledActivity {
  readonly id: string;
  readonly earlyStart: string;
  readonly earlyFinish: string;
  readonly lateStart: string;
  readonly lateFinish: string;
  readonly totalFloatWorkingDays: number;
  readonly critical: boolean;
}

export interface ScheduleResult {
  readonly projectFinish: string;
  readonly activities: readonly ScheduledActivity[];
}

export class ScheduleCycleError extends Error {
  readonly activityIds: readonly string[];

  constructor(activityIds: readonly string[]) {
    super(`Schedule contains a dependency cycle: ${activityIds.join(", ")}`);
    this.name = "ScheduleCycleError";
    this.activityIds = activityIds;
  }
}

interface DateRange {
  readonly start: Date;
  readonly finish: Date;
}

const DAY_IN_MILLISECONDS = 86_400_000;

function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDate(date) !== value) {
    throw new Error(`Invalid ISO calendar date: ${value}`);
  }
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWorkingDay(date: Date): boolean {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

function shiftCalendarDay(date: Date, amount: number): Date {
  return new Date(date.getTime() + amount * DAY_IN_MILLISECONDS);
}

function moveToWorkingDay(date: Date, direction: 1 | -1): Date {
  let result = date;
  while (!isWorkingDay(result)) {
    result = shiftCalendarDay(result, direction);
  }
  return result;
}

function addWorkingDays(date: Date, amount: number): Date {
  let result = date;
  const direction: 1 | -1 = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);

  while (remaining > 0) {
    result = shiftCalendarDay(result, direction);
    if (isWorkingDay(result)) {
      remaining -= 1;
    }
  }
  return result;
}

function workingDayDistance(from: Date, to: Date): number {
  let cursor = from;
  let distance = 0;
  while (cursor.getTime() < to.getTime()) {
    cursor = addWorkingDays(cursor, 1);
    distance += 1;
  }
  return distance;
}

function laterDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function earlierDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function validateActivity(activity: ScheduleActivityInput): void {
  if (!Number.isInteger(activity.durationWorkingDays) || activity.durationWorkingDays < 1) {
    throw new Error(`Activity ${activity.id} must have a positive whole-day duration`);
  }
  for (const dependency of activity.dependencies) {
    if (!Number.isInteger(dependency.lagWorkingDays) || dependency.lagWorkingDays < 0) {
      throw new Error(`Activity ${activity.id} must have a non-negative whole-day lag`);
    }
  }
}

function findCycleActivityIds(
  activities: readonly ScheduleActivityInput[],
  byId: ReadonlyMap<string, ScheduleActivityInput>,
  unresolvedIds: ReadonlySet<string>,
): readonly string[] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycleIds = new Set<string>();

  const visit = (activityId: string): void => {
    const index = nextIndex;
    nextIndex += 1;
    indices.set(activityId, index);
    lowLinks.set(activityId, index);
    stack.push(activityId);
    onStack.add(activityId);

    const activity = byId.get(activityId);
    if (activity === undefined) {
      throw new Error(`Unknown activity: ${activityId}`);
    }
    for (const dependency of activity.dependencies) {
      const predecessorId = dependency.predecessorId;
      if (!unresolvedIds.has(predecessorId)) {
        continue;
      }
      if (!indices.has(predecessorId)) {
        visit(predecessorId);
        lowLinks.set(
          activityId,
          Math.min(lowLinks.get(activityId) ?? index, lowLinks.get(predecessorId) ?? index),
        );
      } else if (onStack.has(predecessorId)) {
        lowLinks.set(
          activityId,
          Math.min(lowLinks.get(activityId) ?? index, indices.get(predecessorId) ?? index),
        );
      }
    }

    if (lowLinks.get(activityId) !== index) {
      return;
    }
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) {
        throw new Error("Invalid cycle detection state");
      }
      onStack.delete(member);
      component.push(member);
    } while (member !== activityId);

    const selfReferential =
      component.length === 1 &&
      activity.dependencies.some((dependency) => dependency.predecessorId === activityId);
    if (component.length > 1 || selfReferential) {
      for (const id of component) {
        cycleIds.add(id);
      }
    }
  };

  for (const activity of activities) {
    if (unresolvedIds.has(activity.id) && !indices.has(activity.id)) {
      visit(activity.id);
    }
  }
  return activities.filter((activity) => cycleIds.has(activity.id)).map((activity) => activity.id);
}

function topologicalOrder(
  activities: readonly ScheduleActivityInput[],
  byId: ReadonlyMap<string, ScheduleActivityInput>,
): readonly ScheduleActivityInput[] {
  const indegree = new Map<string, number>();
  const successors = new Map<string, ScheduleActivityInput[]>();

  for (const activity of activities) {
    indegree.set(activity.id, activity.dependencies.length);
    for (const dependency of activity.dependencies) {
      if (!byId.has(dependency.predecessorId)) {
        throw new Error(`Unknown predecessor: ${dependency.predecessorId}`);
      }
      const entries = successors.get(dependency.predecessorId) ?? [];
      entries.push(activity);
      successors.set(dependency.predecessorId, entries);
    }
  }

  const queue = activities.filter((activity) => indegree.get(activity.id) === 0);
  const ordered: ScheduleActivityInput[] = [];
  for (const activity of queue) {
    ordered.push(activity);
    for (const successor of successors.get(activity.id) ?? []) {
      const nextIndegree = (indegree.get(successor.id) ?? 0) - 1;
      indegree.set(successor.id, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(successor);
      }
    }
  }

  if (ordered.length !== activities.length) {
    const orderedIds = new Set(ordered.map((activity) => activity.id));
    const unresolvedIds = new Set(
      activities.filter((activity) => !orderedIds.has(activity.id)).map((activity) => activity.id),
    );
    throw new ScheduleCycleError(findCycleActivityIds(activities, byId, unresolvedIds));
  }
  return ordered;
}

export function calculateSchedule(input: ScheduleInput): ScheduleResult {
  const projectStart = moveToWorkingDay(parseDate(input.projectStart), 1);
  const byId = new Map(input.activities.map((activity) => [activity.id, activity]));
  if (byId.size !== input.activities.length) {
    throw new Error("Activity IDs must be unique");
  }
  for (const activity of input.activities) {
    validateActivity(activity);
  }

  const ordered = topologicalOrder(input.activities, byId);
  const early = new Map<string, DateRange>();

  for (const activity of ordered) {
    let start = projectStart;
    for (const dependency of activity.dependencies) {
      const predecessor = early.get(dependency.predecessorId);
      if (predecessor === undefined) {
        throw new Error(`Predecessor was not scheduled: ${dependency.predecessorId}`);
      }
      start = laterDate(
        start,
        addWorkingDays(predecessor.finish, dependency.lagWorkingDays + 1),
      );
    }
    early.set(activity.id, {
      start,
      finish: addWorkingDays(start, activity.durationWorkingDays - 1),
    });
  }

  let projectFinish = projectStart;
  for (const range of early.values()) {
    projectFinish = laterDate(projectFinish, range.finish);
  }

  const late = new Map<string, DateRange>();
  for (const activity of [...ordered].reverse()) {
    let finish = projectFinish;
    const successorLinks = input.activities.flatMap((candidate) =>
      candidate.dependencies
        .filter((dependency) => dependency.predecessorId === activity.id)
        .map((dependency) => ({ activity: candidate, dependency })),
    );

    for (const link of successorLinks) {
      const successor = late.get(link.activity.id);
      if (successor === undefined) {
        throw new Error(`Successor was not scheduled: ${link.activity.id}`);
      }
      finish = earlierDate(
        finish,
        addWorkingDays(successor.start, -(link.dependency.lagWorkingDays + 1)),
      );
    }
    late.set(activity.id, {
      start: addWorkingDays(finish, -(activity.durationWorkingDays - 1)),
      finish,
    });
  }

  return {
    projectFinish: formatDate(projectFinish),
    activities: input.activities.map((activity) => {
      const earlyRange = early.get(activity.id);
      const lateRange = late.get(activity.id);
      if (earlyRange === undefined || lateRange === undefined) {
        throw new Error(`Activity was not scheduled: ${activity.id}`);
      }
      const totalFloatWorkingDays = workingDayDistance(earlyRange.start, lateRange.start);
      return {
        id: activity.id,
        earlyStart: formatDate(earlyRange.start),
        earlyFinish: formatDate(earlyRange.finish),
        lateStart: formatDate(lateRange.start),
        lateFinish: formatDate(lateRange.finish),
        totalFloatWorkingDays,
        critical: totalFloatWorkingDays === 0,
      };
    }),
  };
}
