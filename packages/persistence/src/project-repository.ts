import { and, asc, eq, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type {
  MemberRecord,
  PersistedProjectRecord,
  ProcessRecord,
  ProductRecord,
  SubtaskTemplateStepRecord,
  TaskDependencyRecord,
  TaskRecord,
  TemplateRecord,
} from "./project-record.js";
import {
  auditEvents,
  members,
  processes,
  products,
  projectCalendars,
  projects,
  schema,
  subtaskTemplates,
  taskDependencies,
  tasks,
  tenants,
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
      if (record.members.length > 0) {
        await transaction.insert(members).values([...record.members]);
      }
      if (record.processes.length > 0) {
        await transaction.insert(processes).values([...record.processes]);
      }
      if (record.products.length > 0) {
        await transaction.insert(products).values([...record.products]);
      }
      if (record.templates.length > 0) {
        await transaction.insert(subtaskTemplates).values(
          record.templates.map((template) => ({
            ...template,
            subtasks: template.subtasks,
          })),
        );
      }
      if (record.tasks.length > 0) {
        // Self-referential parent FK is satisfied within a single batched
        // insert (immediate constraints are checked at statement end).
        await transaction.insert(tasks).values(
          record.tasks.map((task) => ({ ...task, dailyPlan: task.dailyPlan })),
        );
      }
      if (record.dependencies.length > 0) {
        await transaction.insert(taskDependencies).values([...record.dependencies]);
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

    const calendarRows = await this.database
      .select()
      .from(projectCalendars)
      .where(and(eq(projectCalendars.tenantId, tenantId), eq(projectCalendars.projectId, projectId)))
      .orderBy(asc(projectCalendars.id));
    const memberRows = await this.database
      .select()
      .from(members)
      .where(and(eq(members.tenantId, tenantId), eq(members.projectId, projectId)))
      .orderBy(asc(members.id));
    const processRows = await this.database
      .select()
      .from(processes)
      .where(and(eq(processes.tenantId, tenantId), eq(processes.projectId, projectId)))
      .orderBy(asc(processes.sortOrder), asc(processes.id));
    const productRows = await this.database
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.projectId, projectId)))
      .orderBy(asc(products.sortOrder), asc(products.id));
    const templateRows = await this.database
      .select()
      .from(subtaskTemplates)
      .where(and(eq(subtaskTemplates.tenantId, tenantId), eq(subtaskTemplates.projectId, projectId)))
      .orderBy(asc(subtaskTemplates.sortOrder), asc(subtaskTemplates.id));
    const taskRows = await this.database
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.projectId, projectId)))
      .orderBy(asc(tasks.sortOrder), asc(tasks.id));
    const dependencyRows = await this.database
      .select()
      .from(taskDependencies)
      .where(and(eq(taskDependencies.tenantId, tenantId), eq(taskDependencies.projectId, projectId)))
      .orderBy(
        asc(taskDependencies.successorTaskId),
        asc(taskDependencies.predecessorTaskId),
        asc(taskDependencies.type),
      );
    const auditRows = await this.database
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.projectId, projectId)))
      .orderBy(asc(auditEvents.sequence));

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
      members: memberRows.map(
        (row): MemberRecord => withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
      ),
      processes: processRows.map(
        (row): ProcessRecord => withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
      ),
      products: productRows.map(
        (row): ProductRecord => withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
      ),
      templates: templateRows.map(
        (row): TemplateRecord => ({
          ...withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
          subtasks: row.subtasks as readonly SubtaskTemplateStepRecord[],
        }),
      ),
      tasks: taskRows.map(
        (row): TaskRecord => ({
          ...withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
          dailyPlan: row.dailyPlan as Record<string, number>,
        }),
      ),
      dependencies: dependencyRows.map(
        (row): TaskDependencyRecord => withoutGeneratedFields(row, ["createdAt"]),
      ),
      auditEvents: auditRows.map((row) => ({
        ...withoutGeneratedFields(row, ["sequence"]),
        payload: row.payload as Readonly<Record<string, unknown>>,
        occurredAt: new Date(row.occurredAt).toISOString(),
      })),
    };
  }
}
