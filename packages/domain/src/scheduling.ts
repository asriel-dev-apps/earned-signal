export type DependencyType = "FS" | "SS" | "FF" | "SF";

export interface ScheduleDependency {
  readonly predecessorId: string;
  readonly type?: DependencyType;
  readonly lagWorkingDays: number;
}

export type ScheduleConstraintType =
  | "START_NO_EARLIER_THAN"
  | "FINISH_NO_LATER_THAN"
  | "MUST_START_ON"
  | "MUST_FINISH_ON";

export interface ScheduleConstraintInput {
  readonly type: ScheduleConstraintType;
  readonly date: string;
}

export interface ScheduleActivityInput {
  readonly id: string;
  readonly durationWorkingDays: number;
  readonly calendarId?: string;
  readonly constraint?: ScheduleConstraintInput;
  readonly dependencies: readonly ScheduleDependency[];
}

export interface ScheduleCalendarInput {
  readonly id: string;
  readonly workingWeekdays: readonly number[];
  readonly nonWorkingDates: readonly string[];
}

export interface ScheduleInput {
  readonly projectStart: string;
  readonly defaultCalendarId?: string;
  readonly calendars?: readonly ScheduleCalendarInput[];
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
  readonly constraintViolation?: ScheduleConstraintInput;
}

export interface ScheduleResult {
  readonly projectFinish: string;
  readonly activities: readonly ScheduledActivity[];
}

// Bounds the iterative working-day calculation and covers more than 38 calendar years.
export const MAX_ACTIVITY_DURATION_WORKING_DAYS = 10_000;

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

interface ScheduleCalendar {
  readonly id: string;
  readonly workingWeekdays: ReadonlySet<number>;
  readonly nonWorkingDates: ReadonlySet<string>;
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

function isWorkingDay(date: Date, calendar: ScheduleCalendar): boolean {
  const javascriptDay = date.getUTCDay();
  const isoWeekday = javascriptDay === 0 ? 7 : javascriptDay;
  return (
    calendar.workingWeekdays.has(isoWeekday) &&
    !calendar.nonWorkingDates.has(formatDate(date))
  );
}

function shiftCalendarDay(date: Date, amount: number): Date {
  return new Date(date.getTime() + amount * DAY_IN_MILLISECONDS);
}

function moveToWorkingDay(
  date: Date,
  direction: 1 | -1,
  calendar: ScheduleCalendar,
): Date {
  let result = date;
  while (!isWorkingDay(result, calendar)) {
    result = shiftCalendarDay(result, direction);
  }
  return result;
}

function addWorkingDays(date: Date, amount: number, calendar: ScheduleCalendar): Date {
  let result = date;
  const direction: 1 | -1 = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);

  while (remaining > 0) {
    result = shiftCalendarDay(result, direction);
    if (isWorkingDay(result, calendar)) {
      remaining -= 1;
    }
  }
  return result;
}

function workingDayDistance(from: Date, to: Date, calendar: ScheduleCalendar): number {
  if (from.getTime() > to.getTime()) {
    return -workingDayDistance(to, from, calendar);
  }
  let cursor = from;
  let distance = 0;
  while (cursor.getTime() < to.getTime()) {
    cursor = addWorkingDays(cursor, 1, calendar);
    distance += 1;
  }
  return distance;
}

const STANDARD_CALENDAR: ScheduleCalendar = {
  id: "standard",
  workingWeekdays: new Set([1, 2, 3, 4, 5]),
  nonWorkingDates: new Set(),
};

function resolveCalendars(input: ScheduleInput): {
  readonly byId: ReadonlyMap<string, ScheduleCalendar>;
  readonly defaultCalendar: ScheduleCalendar;
} {
  if (input.calendars === undefined) {
    return { byId: new Map([[STANDARD_CALENDAR.id, STANDARD_CALENDAR]]), defaultCalendar: STANDARD_CALENDAR };
  }
  const calendars = input.calendars.map((calendar): ScheduleCalendar => {
    if (calendar.id.trim().length === 0) {
      throw new Error("Calendar ID must not be blank");
    }
    const weekdays = new Set(calendar.workingWeekdays);
    if (
      weekdays.size === 0 ||
      weekdays.size !== calendar.workingWeekdays.length ||
      [...weekdays].some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)
    ) {
      throw new Error(`Calendar ${calendar.id} must define unique ISO weekdays from 1 to 7`);
    }
    const nonWorkingDates = new Set(calendar.nonWorkingDates);
    for (const date of nonWorkingDates) parseDate(date);
    return { id: calendar.id, workingWeekdays: weekdays, nonWorkingDates };
  });
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  if (byId.size !== calendars.length) {
    throw new Error("Calendar IDs must be unique");
  }
  const defaultCalendar = byId.get(input.defaultCalendarId ?? "");
  if (defaultCalendar === undefined) {
    throw new Error("The default calendar must identify a configured calendar");
  }
  return { byId, defaultCalendar };
}

function laterDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function earlierDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function validateActivity(activity: ScheduleActivityInput): void {
  if (
    !Number.isInteger(activity.durationWorkingDays) ||
    activity.durationWorkingDays < 1 ||
    activity.durationWorkingDays > MAX_ACTIVITY_DURATION_WORKING_DAYS
  ) {
    throw new Error(
      `Activity ${activity.id} duration must be a whole number from 1 to ${MAX_ACTIVITY_DURATION_WORKING_DAYS}`,
    );
  }
  const dependencyKeys = new Set<string>();
  for (const dependency of activity.dependencies) {
    if (
      !Number.isInteger(dependency.lagWorkingDays) ||
      dependency.lagWorkingDays < 0 ||
      dependency.lagWorkingDays > MAX_ACTIVITY_DURATION_WORKING_DAYS
    ) {
      throw new Error(
        `Activity ${activity.id} lag must be a whole number from 0 to ${MAX_ACTIVITY_DURATION_WORKING_DAYS}`,
      );
    }
    if (
      dependency.type !== undefined &&
      !(["FS", "SS", "FF", "SF"] as const).includes(dependency.type)
    ) {
      throw new Error(`Activity ${activity.id} has an unsupported dependency type`);
    }
    const key = `${dependency.predecessorId}\u0000${dependency.type ?? "FS"}`;
    if (dependencyKeys.has(key)) {
      throw new Error(`Activity ${activity.id} has a duplicate dependency`);
    }
    dependencyKeys.add(key);
  }
  if (activity.constraint !== undefined) {
    parseDate(activity.constraint.date);
    if (
      !([
        "START_NO_EARLIER_THAN",
        "FINISH_NO_LATER_THAN",
        "MUST_START_ON",
        "MUST_FINISH_ON",
      ] as const).includes(activity.constraint.type)
    ) {
      throw new Error(`Activity ${activity.id} has an unsupported constraint type`);
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
  const { byId: calendarsById, defaultCalendar } = resolveCalendars(input);
  const calendarFor = (activity: ScheduleActivityInput): ScheduleCalendar => {
    const calendar = calendarsById.get(activity.calendarId ?? defaultCalendar.id);
    if (calendar === undefined) throw new Error(`Unknown calendar: ${activity.calendarId}`);
    return calendar;
  };
  const projectStart = moveToWorkingDay(parseDate(input.projectStart), 1, defaultCalendar);
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
    const calendar = calendarFor(activity);
    let start = moveToWorkingDay(projectStart, 1, calendar);
    for (const dependency of activity.dependencies) {
      const predecessor = early.get(dependency.predecessorId);
      if (predecessor === undefined) {
        throw new Error(`Predecessor was not scheduled: ${dependency.predecessorId}`);
      }
      const type = dependency.type ?? "FS";
      if (type === "FS" || type === "SS") {
        const anchor = type === "FS" ? predecessor.finish : predecessor.start;
        const offset = dependency.lagWorkingDays + (type === "FS" ? 1 : 0);
        start = laterDate(
          start,
          moveToWorkingDay(
            addWorkingDays(anchor, offset, defaultCalendar),
            1,
            calendar,
          ),
        );
      } else {
        const anchor = type === "FF" ? predecessor.finish : predecessor.start;
        const requiredFinish = moveToWorkingDay(
          addWorkingDays(anchor, dependency.lagWorkingDays, defaultCalendar),
          1,
          calendar,
        );
        start = laterDate(
          start,
          addWorkingDays(requiredFinish, -(activity.durationWorkingDays - 1), calendar),
        );
      }
    }
    const constraint = activity.constraint;
    if (constraint?.type === "START_NO_EARLIER_THAN" || constraint?.type === "MUST_START_ON") {
      const requestedStart = parseDate(constraint.date);
      if (constraint.type === "MUST_START_ON" && !isWorkingDay(requestedStart, calendar)) {
        throw new Error(`Activity ${activity.id} must start on a working day`);
      }
      start = laterDate(
        start,
        constraint.type === "MUST_START_ON"
          ? requestedStart
          : moveToWorkingDay(requestedStart, 1, calendar),
      );
    } else if (constraint?.type === "MUST_FINISH_ON") {
      const requestedFinish = parseDate(constraint.date);
      if (!isWorkingDay(requestedFinish, calendar)) {
        throw new Error(`Activity ${activity.id} must finish on a working day`);
      }
      start = laterDate(
        start,
        addWorkingDays(requestedFinish, -(activity.durationWorkingDays - 1), calendar),
      );
    }
    early.set(activity.id, {
      start,
      finish: addWorkingDays(start, activity.durationWorkingDays - 1, calendar),
    });
  }

  let projectFinish = projectStart;
  for (const range of early.values()) {
    projectFinish = laterDate(projectFinish, range.finish);
  }

  const late = new Map<string, DateRange>();
  for (const activity of [...ordered].reverse()) {
    const calendar = calendarFor(activity);
    let finish = moveToWorkingDay(projectFinish, -1, calendar);
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
      const type = link.dependency.type ?? "FS";
      if (type === "FS" || type === "FF") {
        const anchor = type === "FS" ? successor.start : successor.finish;
        const offset = -(link.dependency.lagWorkingDays + (type === "FS" ? 1 : 0));
        finish = earlierDate(
          finish,
          moveToWorkingDay(
            addWorkingDays(anchor, offset, defaultCalendar),
            -1,
            calendar,
          ),
        );
      } else {
        const anchor = type === "SS" ? successor.start : successor.finish;
        const latestStart = moveToWorkingDay(
          addWorkingDays(anchor, -link.dependency.lagWorkingDays, defaultCalendar),
          -1,
          calendar,
        );
        finish = earlierDate(
          finish,
          addWorkingDays(latestStart, activity.durationWorkingDays - 1, calendar),
        );
      }
    }
    const constraint = activity.constraint;
    if (constraint?.type === "FINISH_NO_LATER_THAN" || constraint?.type === "MUST_FINISH_ON") {
      const requestedFinish = parseDate(constraint.date);
      const constrainedFinish =
        constraint.type === "MUST_FINISH_ON"
          ? requestedFinish
          : moveToWorkingDay(requestedFinish, -1, calendar);
      finish = earlierDate(finish, constrainedFinish);
    } else if (constraint?.type === "MUST_START_ON") {
      const constrainedFinish = addWorkingDays(
        parseDate(constraint.date),
        activity.durationWorkingDays - 1,
        calendar,
      );
      finish = earlierDate(finish, constrainedFinish);
    }
    late.set(activity.id, {
      start: addWorkingDays(finish, -(activity.durationWorkingDays - 1), calendar),
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
      const totalFloatWorkingDays = workingDayDistance(
        earlyRange.start,
        lateRange.start,
        calendarFor(activity),
      );
      const constraint = activity.constraint;
      const constraintDate = constraint === undefined ? undefined : parseDate(constraint.date);
      const violatesConstraint =
        constraint !== undefined &&
        constraintDate !== undefined &&
        ((constraint.type === "MUST_START_ON" &&
          earlyRange.start.getTime() !== constraintDate.getTime()) ||
          (constraint.type === "MUST_FINISH_ON" &&
            earlyRange.finish.getTime() !== constraintDate.getTime()) ||
          (constraint.type === "FINISH_NO_LATER_THAN" &&
            earlyRange.finish.getTime() > constraintDate.getTime()) ||
          (constraint.type === "START_NO_EARLIER_THAN" &&
            earlyRange.start.getTime() < constraintDate.getTime()));
      return {
        id: activity.id,
        earlyStart: formatDate(earlyRange.start),
        earlyFinish: formatDate(earlyRange.finish),
        lateStart: formatDate(lateRange.start),
        lateFinish: formatDate(lateRange.finish),
        totalFloatWorkingDays,
        critical: totalFloatWorkingDays <= 0,
        ...(violatesConstraint ? { constraintViolation: constraint } : {}),
      };
    }),
  };
}
