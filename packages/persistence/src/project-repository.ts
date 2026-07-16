import { and, asc, desc, eq, isNotNull, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PersistedProjectRecord } from "./project-record.js";
import {
  activities,
  activitySkillRequirements,
  assignments,
  auditEvents,
  baselineActivities,
  baselineActivitySkillRequirements,
  baselineAssignments,
  baselineCalendars,
  baselineDependencies,
  baselineResources,
  baselineResourceSkills,
  baselineSkills,
  baselineVersions,
  baselineWbsNodes,
  dependencies,
  directActualCosts,
  progressMeasurements,
  projectCalendars,
  projects,
  resources,
  resourceSkills,
  schema,
  skills,
  tenants,
  wbsNodes,
  worklogs,
} from "./schema.js";

function withoutGeneratedFields<T extends object>(
  value: T,
  fields: readonly (keyof T)[],
): T {
  const copy = { ...value };
  for (const field of fields) {
    Reflect.deleteProperty(copy, field);
  }
  return copy;
}

export class ProjectRepository {
  constructor(
    private readonly database:
      | NodePgDatabase<typeof schema>
      | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>,
  ) {}

  async save(record: PersistedProjectRecord): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(tenants).values(record.tenant);
      await transaction.insert(projects).values(record.project);

      if (record.calendars.length > 0) {
        await transaction.insert(projectCalendars).values(
          record.calendars.map((calendar) => ({
            ...calendar,
            workingWeekdays: [...calendar.workingWeekdays],
            nonWorkingDates: [...calendar.nonWorkingDates],
          })),
        );
      }
      if (record.skills.length > 0) {
        await transaction.insert(skills).values([...record.skills]);
      }
      if (record.resources.length > 0) {
        await transaction.insert(resources).values([...record.resources]);
      }
      if (record.resourceSkills.length > 0) {
        await transaction.insert(resourceSkills).values([...record.resourceSkills]);
      }

      if (record.wbsNodes.length > 0) {
        await transaction.insert(wbsNodes).values([...record.wbsNodes]);
      }
      if (record.activities.length > 0) {
        await transaction.insert(activities).values([...record.activities]);
      }
      if (record.activitySkillRequirements.length > 0) {
        await transaction
          .insert(activitySkillRequirements)
          .values([...record.activitySkillRequirements]);
      }
      if (record.assignments.length > 0) {
        await transaction.insert(assignments).values([...record.assignments]);
      }
      if (record.dependencies.length > 0) {
        await transaction.insert(dependencies).values([...record.dependencies]);
      }
      if (record.progressMeasurements.length > 0) {
        await transaction
          .insert(progressMeasurements)
          .values([...record.progressMeasurements]);
      }
      if (record.worklogs.length > 0) {
        await transaction.insert(worklogs).values([...record.worklogs]);
      }
      if (record.directActualCosts.length > 0) {
        await transaction.insert(directActualCosts).values([...record.directActualCosts]);
      }

      if (record.baseline !== null) {
        const { approvedAt, approvedBy, ...draftVersion } = record.baseline.version;
        await transaction
          .insert(baselineVersions)
          .values({ ...draftVersion, approvedAt: null, approvedBy: null });
        if (record.baseline.calendars.length > 0) {
          await transaction.insert(baselineCalendars).values(
            record.baseline.calendars.map((calendar) => ({
              ...calendar,
              workingWeekdays: [...calendar.workingWeekdays],
              nonWorkingDates: [...calendar.nonWorkingDates],
            })),
          );
        }
        if (record.baseline.skills.length > 0) {
          await transaction.insert(baselineSkills).values([...record.baseline.skills]);
        }
        if (record.baseline.resources.length > 0) {
          await transaction.insert(baselineResources).values([...record.baseline.resources]);
        }
        if (record.baseline.resourceSkills.length > 0) {
          await transaction.insert(baselineResourceSkills).values([...record.baseline.resourceSkills]);
        }
        if (record.baseline.wbsNodes.length > 0) {
          await transaction.insert(baselineWbsNodes).values([...record.baseline.wbsNodes]);
        }
        if (record.baseline.activities.length > 0) {
          await transaction
            .insert(baselineActivities)
            .values([...record.baseline.activities]);
        }
        if (record.baseline.activitySkillRequirements.length > 0) {
          await transaction
            .insert(baselineActivitySkillRequirements)
            .values([...record.baseline.activitySkillRequirements]);
        }
        if (record.baseline.assignments.length > 0) {
          await transaction.insert(baselineAssignments).values([...record.baseline.assignments]);
        }
        if (record.baseline.dependencies.length > 0) {
          await transaction
            .insert(baselineDependencies)
            .values([...record.baseline.dependencies]);
        }
        await transaction
          .update(baselineVersions)
          .set({ approvedAt, approvedBy })
          .where(
            and(
              eq(baselineVersions.tenantId, record.project.tenantId),
              eq(baselineVersions.projectId, record.project.id),
              eq(baselineVersions.id, record.baseline.version.id),
            ),
          );
      }
      if (record.auditEvents.length > 0) {
        await transaction.insert(auditEvents).values([...record.auditEvents]);
      }
    });
  }

  async load(tenantId: string, projectId: string): Promise<PersistedProjectRecord | null> {
    const [projectHeader] = await this.database
      .select({
        tenantId: tenants.id,
        tenantName: tenants.name,
        projectId: projects.id,
        name: projects.name,
        currency: projects.currency,
        timezone: projects.timezone,
        projectStart: projects.projectStart,
        statusDate: projects.statusDate,
        defaultCalendarId: projects.defaultCalendarId,
        revision: projects.revision,
      })
      .from(projects)
      .innerJoin(tenants, eq(tenants.id, projects.tenantId))
      .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
      .limit(1);

    if (projectHeader === undefined) {
      return null;
    }

    const wbsRows = await this.database
      .select()
      .from(wbsNodes)
      .where(and(eq(wbsNodes.tenantId, tenantId), eq(wbsNodes.projectId, projectId)))
      .orderBy(asc(wbsNodes.code));
    const calendarRows = await this.database
      .select()
      .from(projectCalendars)
      .where(and(eq(projectCalendars.tenantId, tenantId), eq(projectCalendars.projectId, projectId)))
      .orderBy(asc(projectCalendars.id));
    const skillRows = await this.database
      .select()
      .from(skills)
      .where(and(eq(skills.tenantId, tenantId), eq(skills.projectId, projectId)))
      .orderBy(asc(skills.id));
    const resourceRows = await this.database
      .select()
      .from(resources)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.projectId, projectId)))
      .orderBy(asc(resources.id));
    const resourceSkillRows = await this.database
      .select()
      .from(resourceSkills)
      .where(and(eq(resourceSkills.tenantId, tenantId), eq(resourceSkills.projectId, projectId)))
      .orderBy(asc(resourceSkills.resourceId), asc(resourceSkills.skillId));
    const activityRows = await this.database
      .select()
      .from(activities)
      .where(and(eq(activities.tenantId, tenantId), eq(activities.projectId, projectId)))
      .orderBy(asc(activities.sortOrder));
    const activitySkillRows = await this.database
      .select()
      .from(activitySkillRequirements)
      .where(
        and(
          eq(activitySkillRequirements.tenantId, tenantId),
          eq(activitySkillRequirements.projectId, projectId),
        ),
      )
      .orderBy(
        asc(activitySkillRequirements.activityId),
        asc(activitySkillRequirements.skillId),
      );
    const assignmentRows = await this.database
      .select()
      .from(assignments)
      .where(and(eq(assignments.tenantId, tenantId), eq(assignments.projectId, projectId)))
      .orderBy(asc(assignments.activityId), asc(assignments.resourceId));
    const dependencyRows = await this.database
      .select()
      .from(dependencies)
      .where(and(eq(dependencies.tenantId, tenantId), eq(dependencies.projectId, projectId)))
      .orderBy(
        asc(dependencies.successorActivityId),
        asc(dependencies.predecessorActivityId),
        asc(dependencies.type),
      );
    const progressRows = await this.database
      .select()
      .from(progressMeasurements)
      .where(
        and(
          eq(progressMeasurements.tenantId, tenantId),
          eq(progressMeasurements.projectId, projectId),
        ),
      )
      .orderBy(asc(progressMeasurements.activityId), asc(progressMeasurements.measurementDate));
    const worklogRows = await this.database
      .select()
      .from(worklogs)
      .where(and(eq(worklogs.tenantId, tenantId), eq(worklogs.projectId, projectId)))
      .orderBy(asc(worklogs.activityId), asc(worklogs.workDate));
    const directCostRows = await this.database
      .select()
      .from(directActualCosts)
      .where(
        and(
          eq(directActualCosts.tenantId, tenantId),
          eq(directActualCosts.projectId, projectId),
        ),
      )
      .orderBy(asc(directActualCosts.activityId), asc(directActualCosts.costDate));
    const auditRows = await this.database
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.projectId, projectId)))
      .orderBy(asc(auditEvents.sequence));
    const [baselineVersion] = await this.database
      .select()
      .from(baselineVersions)
      .where(
        and(
          eq(baselineVersions.tenantId, tenantId),
          eq(baselineVersions.projectId, projectId),
          isNotNull(baselineVersions.approvedAt),
        ),
      )
      .orderBy(desc(baselineVersions.version))
      .limit(1);

    const baseline =
      baselineVersion === undefined
        ? null
        : await this.loadBaseline(tenantId, projectId, baselineVersion);

    return {
      tenant: { id: projectHeader.tenantId, name: projectHeader.tenantName },
      project: {
        id: projectHeader.projectId,
        tenantId: projectHeader.tenantId,
        name: projectHeader.name,
        currency: projectHeader.currency,
        timezone: projectHeader.timezone,
        projectStart: projectHeader.projectStart,
        statusDate: projectHeader.statusDate,
        defaultCalendarId: projectHeader.defaultCalendarId,
        revision: projectHeader.revision,
      },
      calendars: calendarRows.map((row) =>
        withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
      ),
      skills: skillRows.map((row) => withoutGeneratedFields(row, ["createdAt", "updatedAt"])),
      resources: resourceRows.map((row) =>
        withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
      ),
      resourceSkills: resourceSkillRows.map((row) =>
        withoutGeneratedFields(row, ["createdAt"]),
      ),
      wbsNodes: wbsRows.map((row) =>
        withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
      ),
      activities: activityRows.map((row) =>
        withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
      ),
      activitySkillRequirements: activitySkillRows.map((row) =>
        withoutGeneratedFields(row, ["createdAt"]),
      ),
      assignments: assignmentRows.map((row) =>
        withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
      ),
      dependencies: dependencyRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      progressMeasurements: progressRows.map((row) =>
        withoutGeneratedFields(row, ["recordedAt"]),
      ),
      worklogs: worklogRows.map((row) => withoutGeneratedFields(row, ["recordedAt"])),
      directActualCosts: directCostRows.map((row) =>
        withoutGeneratedFields(row, ["recordedAt"]),
      ),
      auditEvents: auditRows.map((row) => ({
        ...withoutGeneratedFields(row, ["sequence"]),
        payload: row.payload as Readonly<Record<string, unknown>>,
        occurredAt: new Date(row.occurredAt).toISOString(),
      })),
      baseline,
    };
  }

  private async loadBaseline(
    tenantId: string,
    projectId: string,
    versionRow: typeof baselineVersions.$inferSelect,
  ) {
    const calendarRows = await this.database
      .select()
      .from(baselineCalendars)
      .where(
        and(
          eq(baselineCalendars.tenantId, tenantId),
          eq(baselineCalendars.projectId, projectId),
          eq(baselineCalendars.baselineVersionId, versionRow.id),
        ),
      )
      .orderBy(asc(baselineCalendars.sourceCalendarId));
    const wbsRows = await this.database
      .select()
      .from(baselineWbsNodes)
      .where(
        and(
          eq(baselineWbsNodes.tenantId, tenantId),
          eq(baselineWbsNodes.projectId, projectId),
          eq(baselineWbsNodes.baselineVersionId, versionRow.id),
        ),
      )
      .orderBy(asc(baselineWbsNodes.code));
    const skillRows = await this.database
      .select()
      .from(baselineSkills)
      .where(
        and(
          eq(baselineSkills.tenantId, tenantId),
          eq(baselineSkills.projectId, projectId),
          eq(baselineSkills.baselineVersionId, versionRow.id),
        ),
      )
      .orderBy(asc(baselineSkills.sourceSkillId));
    const resourceRows = await this.database
      .select()
      .from(baselineResources)
      .where(
        and(
          eq(baselineResources.tenantId, tenantId),
          eq(baselineResources.projectId, projectId),
          eq(baselineResources.baselineVersionId, versionRow.id),
        ),
      )
      .orderBy(asc(baselineResources.sourceResourceId));
    const resourceSkillRows = await this.database
      .select()
      .from(baselineResourceSkills)
      .where(
        and(
          eq(baselineResourceSkills.tenantId, tenantId),
          eq(baselineResourceSkills.projectId, projectId),
          eq(baselineResourceSkills.baselineVersionId, versionRow.id),
        ),
      )
      .orderBy(asc(baselineResourceSkills.sourceResourceId), asc(baselineResourceSkills.sourceSkillId));
    const activityRows = await this.database
      .select()
      .from(baselineActivities)
      .where(
        and(
          eq(baselineActivities.tenantId, tenantId),
          eq(baselineActivities.projectId, projectId),
          eq(baselineActivities.baselineVersionId, versionRow.id),
        ),
      )
      .orderBy(asc(baselineActivities.sourceActivityId));
    const dependencyRows = await this.database
      .select()
      .from(baselineDependencies)
      .where(
        and(
          eq(baselineDependencies.tenantId, tenantId),
          eq(baselineDependencies.projectId, projectId),
          eq(baselineDependencies.baselineVersionId, versionRow.id),
        ),
      )
      .orderBy(
        asc(baselineDependencies.successorSourceActivityId),
        asc(baselineDependencies.predecessorSourceActivityId),
        asc(baselineDependencies.type),
      );
    const activitySkillRows = await this.database
      .select()
      .from(baselineActivitySkillRequirements)
      .where(
        and(
          eq(baselineActivitySkillRequirements.tenantId, tenantId),
          eq(baselineActivitySkillRequirements.projectId, projectId),
          eq(baselineActivitySkillRequirements.baselineVersionId, versionRow.id),
        ),
      )
      .orderBy(asc(baselineActivitySkillRequirements.sourceActivityId), asc(baselineActivitySkillRequirements.sourceSkillId));
    const assignmentRows = await this.database
      .select()
      .from(baselineAssignments)
      .where(
        and(
          eq(baselineAssignments.tenantId, tenantId),
          eq(baselineAssignments.projectId, projectId),
          eq(baselineAssignments.baselineVersionId, versionRow.id),
        ),
      )
      .orderBy(asc(baselineAssignments.sourceActivityId), asc(baselineAssignments.sourceResourceId));
    const { approvedAt, approvedBy } = versionRow;
    if (approvedAt === null || approvedBy === null) {
      throw new Error(`Baseline ${versionRow.id} is not approved`);
    }

    return {
      version: {
        ...withoutGeneratedFields(versionRow, ["createdAt"]),
        approvedAt: new Date(approvedAt).toISOString(),
        approvedBy,
      },
      calendars: calendarRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      skills: skillRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      resources: resourceRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      resourceSkills: resourceSkillRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      wbsNodes: wbsRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      activities: activityRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      activitySkillRequirements: activitySkillRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      assignments: assignmentRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      dependencies: dependencyRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
    };
  }
}
