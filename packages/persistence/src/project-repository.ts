import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PersistedProjectRecord } from "./project-record.js";
import {
  activities,
  auditEvents,
  baselineActivities,
  baselineDependencies,
  baselineVersions,
  baselineWbsNodes,
  dependencies,
  directActualCosts,
  progressMeasurements,
  projects,
  schema,
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
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async save(record: PersistedProjectRecord): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(tenants).values(record.tenant);
      await transaction.insert(projects).values(record.project);

      if (record.wbsNodes.length > 0) {
        await transaction.insert(wbsNodes).values([...record.wbsNodes]);
      }
      if (record.activities.length > 0) {
        await transaction.insert(activities).values([...record.activities]);
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
        if (record.baseline.wbsNodes.length > 0) {
          await transaction.insert(baselineWbsNodes).values([...record.baseline.wbsNodes]);
        }
        if (record.baseline.activities.length > 0) {
          await transaction
            .insert(baselineActivities)
            .values([...record.baseline.activities]);
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
    const activityRows = await this.database
      .select()
      .from(activities)
      .where(and(eq(activities.tenantId, tenantId), eq(activities.projectId, projectId)))
      .orderBy(asc(activities.sortOrder));
    const dependencyRows = await this.database
      .select()
      .from(dependencies)
      .where(and(eq(dependencies.tenantId, tenantId), eq(dependencies.projectId, projectId)))
      .orderBy(asc(dependencies.successorActivityId));
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
        revision: projectHeader.revision,
      },
      wbsNodes: wbsRows.map((row) =>
        withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
      ),
      activities: activityRows.map((row) =>
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
      .orderBy(asc(baselineDependencies.successorSourceActivityId));
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
      wbsNodes: wbsRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      activities: activityRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
      dependencies: dependencyRows.map((row) => withoutGeneratedFields(row, ["createdAt"])),
    };
  }
}
