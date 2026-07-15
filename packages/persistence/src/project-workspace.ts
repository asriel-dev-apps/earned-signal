import type { ProjectState } from "@earned-signal/application";
import type { PersistedProjectRecord } from "./project-record.js";
import { ProjectRepository } from "./project-repository.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { schema } from "./schema.js";

export interface ProjectWorkspace {
  readonly revision: bigint;
  readonly current: ProjectState;
  readonly baseline: ProjectState | null;
  readonly baselineVersion: {
    readonly id: string;
    readonly version: number;
    readonly label: string;
    readonly approvedAt: string;
  } | null;
}

function safeNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe application range`);
  return result;
}

function currentState(record: PersistedProjectRecord): ProjectState {
  const activityWbsIds = new Set(record.activities.map((activity) => activity.wbsNodeId));
  const wbsById = new Map(record.wbsNodes.map((node) => [node.id, node]));
  const dependencies = new Map<string, Array<{ predecessorId: string; type: "FS" | "SS" | "FF" | "SF"; lagWorkingDays: number }>>();
  for (const dependency of record.dependencies) {
    const entries = dependencies.get(dependency.successorActivityId) ?? [];
    entries.push({ predecessorId: dependency.predecessorActivityId, type: dependency.type, lagWorkingDays: dependency.lagWorkingDays });
    dependencies.set(dependency.successorActivityId, entries);
  }
  const progress = new Map<string, number>();
  for (const measurement of record.progressMeasurements) {
    if (measurement.measurementDate <= record.project.statusDate) progress.set(measurement.activityId, measurement.progressBasisPoints / 100);
  }
  const minutes = new Map<string, number>();
  for (const worklog of record.worklogs) minutes.set(worklog.activityId, (minutes.get(worklog.activityId) ?? 0) + worklog.actualMinutes);
  const costs = new Map<string, bigint>();
  for (const cost of record.directActualCosts) costs.set(cost.activityId, (costs.get(cost.activityId) ?? 0n) + cost.amountMinor);
  const resourceSkills = new Map<string, string[]>();
  for (const entry of record.resourceSkills) resourceSkills.set(entry.resourceId, [...(resourceSkills.get(entry.resourceId) ?? []), entry.skillId]);
  const activitySkills = new Map<string, string[]>();
  for (const entry of record.activitySkillRequirements) activitySkills.set(entry.activityId, [...(activitySkills.get(entry.activityId) ?? []), entry.skillId]);
  return {
    id: record.project.id,
    name: record.project.name,
    projectStart: record.project.projectStart,
    statusDate: record.project.statusDate,
    currency: "JPY",
    defaultCalendarId: record.project.defaultCalendarId,
    calendars: record.calendars.map(({ id, name, workingWeekdays, nonWorkingDates }) => ({ id, name, workingWeekdays, nonWorkingDates })),
    wbsGroups: record.wbsNodes.filter((node) => !activityWbsIds.has(node.id)).map(({ id, parentId, code, name }) => ({ id, parentId, code, name })),
    skills: record.skills.map(({ id, name }) => ({ id, name })),
    resources: record.resources.map((resource) => ({ id: resource.id, name: resource.name, calendarId: resource.calendarId, dailyCapacityMinutes: resource.dailyCapacityMinutes, costRateMinorPerHour: safeNumber(resource.costRateMinorPerHour, `Cost rate for ${resource.id}`), skillIds: resourceSkills.get(resource.id) ?? [] })),
    assignments: record.assignments.map((assignment) => ({ taskId: assignment.activityId, resourceId: assignment.resourceId, unitsPercent: assignment.unitsPercent })),
    tasks: record.activities.map((activity) => {
      const wbs = wbsById.get(activity.wbsNodeId);
      if (wbs === undefined) throw new Error(`Activity ${activity.id} has no WBS node`);
      return {
        id: activity.id,
        wbs: wbs.code,
        wbsParentId: wbs.parentId,
        name: activity.name,
        owner: activity.owner,
        durationWorkingDays: activity.durationWorkingDays,
        measurementMethod: activity.measurementMethod,
        calendarId: activity.calendarId,
        dependencies: dependencies.get(activity.id) ?? [],
        constraint: activity.constraintType === null || activity.constraintDate === null ? null : { type: activity.constraintType, date: activity.constraintDate },
        requiredSkillIds: activitySkills.get(activity.id) ?? [],
        budget: safeNumber(activity.budgetMinor, `Budget for ${activity.id}`),
        progressPercent: progress.get(activity.id) ?? 0,
        actualCost: safeNumber(costs.get(activity.id) ?? 0n, `Actual cost for ${activity.id}`),
        actualMinutes: minutes.get(activity.id) ?? 0,
      };
    }),
  };
}

export function toProjectWorkspace(record: PersistedProjectRecord): ProjectWorkspace {
  const current = currentState(record);
  if (record.baseline === null) return { revision: record.project.revision, current, baseline: null, baselineVersion: null };
  const baselineResourceSkills = new Map<string, string[]>();
  for (const entry of record.baseline.resourceSkills) {
    baselineResourceSkills.set(
      entry.sourceResourceId,
      [...(baselineResourceSkills.get(entry.sourceResourceId) ?? []), entry.sourceSkillId],
    );
  }
  const baselineActivitySkills = new Map<string, string[]>();
  for (const entry of record.baseline.activitySkillRequirements) {
    baselineActivitySkills.set(
      entry.sourceActivityId,
      [...(baselineActivitySkills.get(entry.sourceActivityId) ?? []), entry.sourceSkillId],
    );
  }
  const baselineDependencies = new Map<string, Array<{ predecessorId: string; type: "FS" | "SS" | "FF" | "SF"; lagWorkingDays: number }>>();
  for (const dependency of record.baseline.dependencies) {
    const entries = baselineDependencies.get(dependency.successorSourceActivityId) ?? [];
    entries.push({ predecessorId: dependency.predecessorSourceActivityId, type: dependency.type, lagWorkingDays: dependency.lagWorkingDays });
    baselineDependencies.set(dependency.successorSourceActivityId, entries);
  }
  const baseline: ProjectState = {
    ...current,
    defaultCalendarId: record.baseline.version.defaultCalendarId,
    calendars: record.baseline.calendars.map((calendar) => ({ id: calendar.sourceCalendarId, name: calendar.name, workingWeekdays: calendar.workingWeekdays, nonWorkingDates: calendar.nonWorkingDates })),
    wbsGroups: record.baseline.wbsNodes.filter((node) => !record.baseline!.activities.some((activity) => activity.sourceWbsNodeId === node.sourceWbsNodeId)).map((node) => ({ id: node.sourceWbsNodeId, parentId: node.parentSourceWbsNodeId, code: node.code, name: node.name })),
    skills: record.baseline.skills.map((skill) => ({ id: skill.sourceSkillId, name: skill.name })),
    resources: record.baseline.resources.map((resource) => ({
      id: resource.sourceResourceId,
      name: resource.name,
      calendarId: resource.calendarId,
      dailyCapacityMinutes: resource.dailyCapacityMinutes,
      costRateMinorPerHour: safeNumber(resource.costRateMinorPerHour, `Baseline cost rate for ${resource.sourceResourceId}`),
      skillIds: baselineResourceSkills.get(resource.sourceResourceId) ?? [],
    })),
    assignments: record.baseline.assignments.map((assignment) => ({
      taskId: assignment.sourceActivityId,
      resourceId: assignment.sourceResourceId,
      unitsPercent: assignment.unitsPercent,
    })),
    tasks: record.baseline.activities.map((activity) => {
      return {
        id: activity.sourceActivityId,
        wbs: activity.wbsCode,
        wbsParentId: record.baseline!.wbsNodes.find((node) => node.sourceWbsNodeId === activity.sourceWbsNodeId)?.parentSourceWbsNodeId ?? null,
        name: activity.name,
        owner: activity.owner,
        durationWorkingDays: activity.durationWorkingDays,
        measurementMethod: activity.measurementMethod,
        calendarId: activity.calendarId,
        dependencies: baselineDependencies.get(activity.sourceActivityId) ?? [],
        constraint: activity.constraintType === null || activity.constraintDate === null ? null : { type: activity.constraintType, date: activity.constraintDate },
        requiredSkillIds: baselineActivitySkills.get(activity.sourceActivityId) ?? [],
        budget: safeNumber(activity.budgetMinor, `Baseline budget for ${activity.sourceActivityId}`),
        progressPercent: 0,
        actualCost: 0,
        actualMinutes: 0,
      };
    }),
  };
  return {
    revision: record.project.revision,
    current,
    baseline,
    baselineVersion: { id: record.baseline.version.id, version: record.baseline.version.version, label: record.baseline.version.label, approvedAt: record.baseline.version.approvedAt },
  };
}

export class ProjectWorkspaceRepository {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}
  async load(tenantId: string, projectId: string): Promise<ProjectWorkspace | null> {
    return this.database.transaction(async (transaction) => {
      const record = await new ProjectRepository(transaction).load(tenantId, projectId);
      return record === null ? null : toProjectWorkspace(record);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
}
