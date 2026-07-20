import type { ProjectState } from "@earned-signal/application";
import type { PersistedProjectRecord } from "./project-record.js";
import { ProjectRepository } from "./project-repository.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { schema } from "./schema.js";

export interface ProjectWorkspace {
  readonly revision: bigint;
  readonly current: ProjectState;
}

export function toProjectState(record: PersistedProjectRecord): ProjectState {
  const dependenciesByTask = new Map<
    string,
    Array<{ predecessorId: string; type: "FS" | "SS" | "FF" | "SF"; lagWorkingDays: number }>
  >();
  for (const dependency of record.dependencies) {
    const entries = dependenciesByTask.get(dependency.successorTaskId) ?? [];
    entries.push({
      predecessorId: dependency.predecessorTaskId,
      type: dependency.type,
      lagWorkingDays: dependency.lagWorkingDays,
    });
    dependenciesByTask.set(dependency.successorTaskId, entries);
  }

  return {
    id: record.project.id,
    name: record.project.name,
    projectStart: record.project.projectStart,
    statusDate: record.project.statusDate,
    currency: "JPY",
    defaultCalendarId: record.project.defaultCalendarId,
    calendars: record.calendars.map(({ id, name, workingWeekdays, nonWorkingDates }) => ({
      id,
      name,
      workingWeekdays,
      nonWorkingDates,
    })),
    members: record.members.map(({ id, name, calendarId, dailyCapacityMinutes }) => ({
      id,
      name,
      calendarId,
      dailyCapacityMinutes,
    })),
    tasks: record.tasks.map((task) => ({
      id: task.id,
      parentId: task.parentTaskId,
      sortOrder: task.sortOrder,
      name: task.name,
      process: task.process,
      product: task.product,
      reviewRef: task.reviewRef,
      changeRef: task.changeRef,
      note: task.note,
      contract: task.contract,
      assigneeMemberId: task.assigneeMemberId,
      plannedEffortMinutes: task.plannedEffortMinutes,
      progressBasisPoints: task.progressBasisPoints,
      actualEffortMinutes: task.actualEffortMinutes,
      dailyPlan: task.dailyPlan,
      dailyPlanLocked: task.dailyPlanLocked,
      actualStart: task.actualStart,
      actualFinish: task.actualFinish,
      dependencies: dependenciesByTask.get(task.id) ?? [],
    })),
  };
}

export function toProjectWorkspace(record: PersistedProjectRecord): ProjectWorkspace {
  return { revision: record.project.revision, current: toProjectState(record) };
}

export class ProjectWorkspaceRepository {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}
  async load(tenantId: string, projectId: string): Promise<ProjectWorkspace | null> {
    return this.database.transaction(
      async (transaction) => {
        const record = await new ProjectRepository(transaction).load(tenantId, projectId);
        return record === null ? null : toProjectWorkspace(record);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
