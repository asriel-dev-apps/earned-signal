export interface CapacityCalendarInput {
  readonly id: string;
  readonly workingWeekdays: readonly number[];
  readonly nonWorkingDates: readonly string[];
}

export interface CapacitySkillInput {
  readonly id: string;
  readonly name: string;
}

export interface CapacityResourceInput {
  readonly id: string;
  readonly calendarId: string;
  readonly dailyCapacityMinutes: number;
  readonly costRateMinorPerHour: number;
  readonly skillIds: readonly string[];
}

export interface CapacityActivityInput {
  readonly id: string;
  readonly start: string;
  readonly finish: string;
  readonly requiredSkillIds: readonly string[];
}

export interface CapacityAssignmentInput {
  readonly activityId: string;
  readonly resourceId: string;
  readonly unitsPercent: number;
}

export interface CapacityInput {
  readonly periodStart: string;
  readonly periodFinish: string;
  readonly calendars: readonly CapacityCalendarInput[];
  readonly skills: readonly CapacitySkillInput[];
  readonly resources: readonly CapacityResourceInput[];
  readonly activities: readonly CapacityActivityInput[];
  readonly assignments: readonly CapacityAssignmentInput[];
}

export interface ResourceCapacityDay {
  readonly date: string;
  readonly capacityMinutes: number;
  readonly demandMinutes: number;
  readonly overallocatedMinutes: number;
}

export interface ResourceCapacityResult {
  readonly resourceId: string;
  readonly totalCapacityMinutes: number;
  readonly totalDemandMinutes: number;
  readonly overallocatedMinutes: number;
  readonly utilizationPercent: number;
  readonly plannedLaborCostMinor: number;
  readonly skillGapActivityIds: readonly string[];
  readonly days: readonly ResourceCapacityDay[];
}

export interface CapacityResult {
  readonly resources: readonly ResourceCapacityResult[];
  readonly overallocatedResourceIds: readonly string[];
  readonly skillGapActivityIds: readonly string[];
}

const DAY_MILLISECONDS = 86_400_000;
const MAX_PERIOD_CALENDAR_DAYS = 50_000;

function parseDate(value: string): Date {
  const result = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(result.getTime()) || result.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ISO calendar date: ${value}`);
  }
  return result;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function uniqueIds(values: readonly { readonly id: string }[], label: string): void {
  const ids = new Set(values.map((value) => value.id));
  if (ids.size !== values.length || [...ids].some((id) => id.trim().length === 0)) {
    throw new Error(`${label} IDs must be unique and non-blank`);
  }
}

export function calculateCapacity(input: CapacityInput): CapacityResult {
  uniqueIds(input.calendars, "Calendar");
  uniqueIds(input.skills, "Skill");
  uniqueIds(input.resources, "Resource");
  uniqueIds(input.activities, "Activity");

  const periodStart = parseDate(input.periodStart);
  const periodFinish = parseDate(input.periodFinish);
  const calendarDays = Math.round(
    (periodFinish.getTime() - periodStart.getTime()) / DAY_MILLISECONDS,
  );
  if (calendarDays < 0 || calendarDays > MAX_PERIOD_CALENDAR_DAYS) {
    throw new Error(`Capacity period must span 0 to ${MAX_PERIOD_CALENDAR_DAYS} calendar days`);
  }

  const skillIds = new Set(input.skills.map((skill) => skill.id));
  const calendars = new Map(
    input.calendars.map((calendar) => {
      const weekdays = new Set(calendar.workingWeekdays);
      if (
        weekdays.size === 0 ||
        weekdays.size !== calendar.workingWeekdays.length ||
        [...weekdays].some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)
      ) {
        throw new Error(`Calendar ${calendar.id} has invalid working weekdays`);
      }
      const nonWorkingDates = new Set(calendar.nonWorkingDates);
      for (const date of nonWorkingDates) parseDate(date);
      return [calendar.id, { weekdays, nonWorkingDates }] as const;
    }),
  );
  const activities = new Map(
    input.activities.map((activity) => {
      const start = parseDate(activity.start);
      const finish = parseDate(activity.finish);
      if (finish.getTime() < start.getTime()) {
        throw new Error(`Activity ${activity.id} finish precedes its start`);
      }
      if (activity.requiredSkillIds.some((id) => !skillIds.has(id))) {
        throw new Error(`Activity ${activity.id} references an unknown skill`);
      }
      return [activity.id, { ...activity, start, finish }] as const;
    }),
  );
  const resources = new Map(input.resources.map((resource) => [resource.id, resource]));
  for (const resource of input.resources) {
    if (!calendars.has(resource.calendarId)) {
      throw new Error(`Resource ${resource.id} references an unknown calendar`);
    }
    if (
      !Number.isInteger(resource.dailyCapacityMinutes) ||
      resource.dailyCapacityMinutes < 1 ||
      resource.dailyCapacityMinutes > 1_440
    ) {
      throw new Error(`Resource ${resource.id} daily capacity must be from 1 to 1440 minutes`);
    }
    if (!Number.isSafeInteger(resource.costRateMinorPerHour) || resource.costRateMinorPerHour < 0) {
      throw new Error(`Resource ${resource.id} cost rate must be safe non-negative minor units`);
    }
    if (new Set(resource.skillIds).size !== resource.skillIds.length) {
      throw new Error(`Resource ${resource.id} skill IDs must be unique`);
    }
    if (resource.skillIds.some((id) => !skillIds.has(id))) {
      throw new Error(`Resource ${resource.id} references an unknown skill`);
    }
  }

  const assignmentKeys = new Set<string>();
  for (const assignment of input.assignments) {
    if (!activities.has(assignment.activityId) || !resources.has(assignment.resourceId)) {
      throw new Error("Assignment references an unknown activity or resource");
    }
    if (
      !Number.isInteger(assignment.unitsPercent) ||
      assignment.unitsPercent < 1 ||
      assignment.unitsPercent > 100
    ) {
      throw new Error("Assignment units must be a whole percentage from 1 to 100");
    }
    const key = `${assignment.activityId}\u0000${assignment.resourceId}`;
    if (assignmentKeys.has(key)) throw new Error("Assignments must be unique per activity and resource");
    assignmentKeys.add(key);
  }

  const skillGapActivityIds = input.activities
    .filter((activity) => {
      const assignedSkillIds = new Set(
        input.assignments
          .filter((assignment) => assignment.activityId === activity.id)
          .flatMap((assignment) => resources.get(assignment.resourceId)?.skillIds ?? []),
      );
      return activity.requiredSkillIds.some((skillId) => !assignedSkillIds.has(skillId));
    })
    .map((activity) => activity.id);
  const skillGapActivities = new Set(skillGapActivityIds);

  const dates: Date[] = [];
  for (let cursor = periodStart; cursor.getTime() <= periodFinish.getTime(); ) {
    dates.push(cursor);
    cursor = new Date(cursor.getTime() + DAY_MILLISECONDS);
  }

  const resourceResults = input.resources.map((resource): ResourceCapacityResult => {
    const calendar = calendars.get(resource.calendarId);
    if (calendar === undefined) throw new Error(`Unknown resource calendar: ${resource.calendarId}`);
    const resourceAssignments = input.assignments.filter(
      (assignment) => assignment.resourceId === resource.id,
    );
    const days = dates.map((date): ResourceCapacityDay => {
      const dateText = formatDate(date);
      const javascriptDay = date.getUTCDay();
      const isoWeekday = javascriptDay === 0 ? 7 : javascriptDay;
      const working =
        calendar.weekdays.has(isoWeekday) && !calendar.nonWorkingDates.has(dateText);
      const capacityMinutes = working ? resource.dailyCapacityMinutes : 0;
      const demandMinutes = working
        ? resourceAssignments.reduce((total, assignment) => {
            const activity = activities.get(assignment.activityId);
            if (
              activity === undefined ||
              date.getTime() < activity.start.getTime() ||
              date.getTime() > activity.finish.getTime()
            ) {
              return total;
            }
            return total + (resource.dailyCapacityMinutes * assignment.unitsPercent) / 100;
          }, 0)
        : 0;
      return {
        date: dateText,
        capacityMinutes,
        demandMinutes,
        overallocatedMinutes: Math.max(0, demandMinutes - capacityMinutes),
      };
    });
    const totalCapacityMinutes = days.reduce((total, day) => total + day.capacityMinutes, 0);
    const totalDemandMinutes = days.reduce((total, day) => total + day.demandMinutes, 0);
    const overallocatedMinutes = days.reduce(
      (total, day) => total + day.overallocatedMinutes,
      0,
    );
    const skillGapActivityIds = [
      ...new Set(
        resourceAssignments.flatMap((assignment) =>
          skillGapActivities.has(assignment.activityId) ? [assignment.activityId] : [],
        ),
      ),
    ];
    return {
      resourceId: resource.id,
      totalCapacityMinutes,
      totalDemandMinutes,
      overallocatedMinutes,
      utilizationPercent:
        totalCapacityMinutes === 0 ? 0 : (totalDemandMinutes / totalCapacityMinutes) * 100,
      plannedLaborCostMinor: (totalDemandMinutes * resource.costRateMinorPerHour) / 60,
      skillGapActivityIds,
      days,
    };
  });

  return {
    resources: resourceResults,
    overallocatedResourceIds: resourceResults
      .filter((resource) => resource.overallocatedMinutes > 0)
      .map((resource) => resource.resourceId),
    skillGapActivityIds,
  };
}
