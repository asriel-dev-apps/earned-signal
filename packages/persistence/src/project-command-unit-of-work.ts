import { createHash } from "node:crypto";
import {
  applyEffortSchedule,
  IdempotencyConflictError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
} from "@earned-signal/application";
import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  auditEvents,
  commandReceipts,
  members,
  projectCalendars,
  projects,
  schema,
  taskDependencies,
  tasks,
} from "./schema.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Command fingerprint contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`Command fingerprint contains unsupported data: ${typeof value}`);
}

function requestHash(request: ProjectCommandRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        actor: request.actor,
        command: request.command,
        expectedRevision: request.expectedRevision,
      }),
    )
    .digest("hex");
}

export class PostgresProjectCommandUnitOfWork implements ProjectCommandUnitOfWork {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async execute(
    request: ProjectCommandRequest,
    transition: (project: ProjectState) => ProjectState,
  ): Promise<ProjectCommandExecution> {
    const fingerprint = requestHash(request);

    return this.database.transaction(async (transaction) => {
      const findReceipt = () =>
        transaction
          .select()
          .from(commandReceipts)
          .where(
            and(
              eq(commandReceipts.tenantId, request.tenantId),
              eq(commandReceipts.projectId, request.projectId),
              eq(commandReceipts.idempotencyKey, request.idempotencyKey),
            ),
          )
          .limit(1);

      const replay = (receipt: typeof commandReceipts.$inferSelect) => {
        if (receipt.requestHash !== fingerprint) {
          throw new IdempotencyConflictError(request.idempotencyKey);
        }
        return {
          projectId: request.projectId,
          revision: receipt.resultRevision,
          replayed: true,
        } satisfies ProjectCommandExecution;
      };

      const [existingReceipt] = await findReceipt();
      if (existingReceipt !== undefined) {
        return replay(existingReceipt);
      }

      const lockedProject = await transaction.execute<{ revision: string }>(sql`
        select revision::text as revision
        from projects
        where tenant_id = ${request.tenantId} and id = ${request.projectId}
        for update
      `);
      const lockedRow = lockedProject.rows[0];
      if (lockedRow === undefined) {
        throw new ProjectNotFoundError(request.projectId);
      }

      const [concurrentReceipt] = await findReceipt();
      if (concurrentReceipt !== undefined) {
        return replay(concurrentReceipt);
      }

      const actualRevision = BigInt(lockedRow.revision);
      if (actualRevision !== request.expectedRevision) {
        throw new ProjectVersionConflictError(request.expectedRevision, actualRevision);
      }

      const [projectRow] = await transaction
        .select({
          id: projects.id,
          name: projects.name,
          projectStart: projects.projectStart,
          statusDate: projects.statusDate,
          currency: projects.currency,
          defaultCalendarId: projects.defaultCalendarId,
        })
        .from(projects)
        .where(and(eq(projects.tenantId, request.tenantId), eq(projects.id, request.projectId)))
        .limit(1);
      if (projectRow === undefined) {
        throw new ProjectNotFoundError(request.projectId);
      }
      if (projectRow.currency !== "JPY") {
        throw new Error(`Unsupported application currency: ${projectRow.currency}`);
      }

      const taskRows = await transaction
        .select()
        .from(tasks)
        .where(and(eq(tasks.tenantId, request.tenantId), eq(tasks.projectId, request.projectId)))
        .orderBy(asc(tasks.sortOrder));
      const calendarRows = await transaction
        .select()
        .from(projectCalendars)
        .where(
          and(
            eq(projectCalendars.tenantId, request.tenantId),
            eq(projectCalendars.projectId, request.projectId),
          ),
        )
        .orderBy(asc(projectCalendars.id));
      const memberRows = await transaction
        .select()
        .from(members)
        .where(and(eq(members.tenantId, request.tenantId), eq(members.projectId, request.projectId)))
        .orderBy(asc(members.id));
      const dependencyRows = await transaction
        .select()
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.tenantId, request.tenantId),
            eq(taskDependencies.projectId, request.projectId),
          ),
        )
        .orderBy(
          asc(taskDependencies.successorTaskId),
          asc(taskDependencies.predecessorTaskId),
          asc(taskDependencies.type),
        );

      const dependenciesByTask = new Map<
        string,
        Array<{ predecessorId: string; type: "FS" | "SS" | "FF" | "SF"; lagWorkingDays: number }>
      >();
      for (const dependency of dependencyRows) {
        const entries = dependenciesByTask.get(dependency.successorTaskId) ?? [];
        entries.push({
          predecessorId: dependency.predecessorTaskId,
          type: dependency.type,
          lagWorkingDays: dependency.lagWorkingDays,
        });
        dependenciesByTask.set(dependency.successorTaskId, entries);
      }

      const current: ProjectState = {
        id: projectRow.id,
        name: projectRow.name,
        projectStart: projectRow.projectStart,
        statusDate: projectRow.statusDate,
        currency: "JPY",
        defaultCalendarId: projectRow.defaultCalendarId,
        calendars: calendarRows.map((calendar) => ({
          id: calendar.id,
          name: calendar.name,
          workingWeekdays: calendar.workingWeekdays,
          nonWorkingDates: calendar.nonWorkingDates,
        })),
        members: memberRows.map((member) => ({
          id: member.id,
          name: member.name,
          calendarId: member.calendarId,
          dailyCapacityMinutes: member.dailyCapacityMinutes,
        })),
        tasks: taskRows.map((task) => ({
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
          dailyPlan: task.dailyPlan as Record<string, number>,
          dailyPlanLocked: task.dailyPlanLocked,
          actualStart: task.actualStart,
          actualFinish: task.actualFinish,
          dependencies: dependenciesByTask.get(task.id) ?? [],
        })),
      };

      // Apply the validated command, then re-run the deterministic capacity-aware
      // scheduler so every unlocked task's daily plan is auto-placed (D17) before
      // it is persisted. Locked tasks keep their hand-edited plan. This keeps
      // M = Σ daily and P/Q consistent with the effort EVM projection.
      const next = applyEffortSchedule(transition(current));
      const nextTaskById = new Map(next.tasks.map((task) => [task.id, task]));
      const nextMemberById = new Map(next.members.map((member) => [member.id, member]));
      const currentMemberIds = new Set(memberRows.map((member) => member.id));

      // Free all self-FK (parent) and assignee references so deletes and inserts
      // never collide with RESTRICT constraints.
      await transaction
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.tenantId, request.tenantId),
            eq(taskDependencies.projectId, request.projectId),
          ),
        );
      if (taskRows.length > 0) {
        await transaction
          .update(tasks)
          .set({ parentTaskId: null, assigneeMemberId: null })
          .where(and(eq(tasks.tenantId, request.tenantId), eq(tasks.projectId, request.projectId)));
      }

      // Members: insert / update present, delete removed (now unreferenced).
      for (const member of next.members) {
        const values = {
          name: member.name,
          calendarId: member.calendarId,
          dailyCapacityMinutes: member.dailyCapacityMinutes,
        };
        if (currentMemberIds.has(member.id)) {
          await transaction
            .update(members)
            .set({ ...values, updatedAt: sql`now()` })
            .where(
              and(
                eq(members.tenantId, request.tenantId),
                eq(members.projectId, request.projectId),
                eq(members.id, member.id),
              ),
            );
        } else {
          await transaction.insert(members).values({
            id: member.id,
            tenantId: request.tenantId,
            projectId: request.projectId,
            ...values,
          });
        }
      }
      for (const member of memberRows) {
        if (!nextMemberById.has(member.id)) {
          await transaction
            .delete(members)
            .where(
              and(
                eq(members.tenantId, request.tenantId),
                eq(members.projectId, request.projectId),
                eq(members.id, member.id),
              ),
            );
        }
      }

      // Delete removed tasks (parent references already nulled above).
      for (const task of taskRows) {
        if (!nextTaskById.has(task.id)) {
          await transaction
            .delete(tasks)
            .where(
              and(
                eq(tasks.tenantId, request.tenantId),
                eq(tasks.projectId, request.projectId),
                eq(tasks.id, task.id),
              ),
            );
        }
      }

      // Upsert task native columns (parent deferred to a second pass so every
      // parent target exists before the self-FK is set).
      const currentTaskIds = new Set(taskRows.map((task) => task.id));
      for (const task of next.tasks) {
        const values = {
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
        };
        if (currentTaskIds.has(task.id)) {
          await transaction
            .update(tasks)
            .set({ ...values, parentTaskId: null, updatedAt: sql`now()` })
            .where(
              and(
                eq(tasks.tenantId, request.tenantId),
                eq(tasks.projectId, request.projectId),
                eq(tasks.id, task.id),
              ),
            );
        } else {
          await transaction.insert(tasks).values({
            id: task.id,
            tenantId: request.tenantId,
            projectId: request.projectId,
            parentTaskId: null,
            ...values,
          });
        }
      }
      for (const task of next.tasks) {
        if (task.parentId !== null) {
          await transaction
            .update(tasks)
            .set({ parentTaskId: task.parentId })
            .where(
              and(
                eq(tasks.tenantId, request.tenantId),
                eq(tasks.projectId, request.projectId),
                eq(tasks.id, task.id),
              ),
            );
        }
      }

      const dependencyValues = next.tasks.flatMap((task) =>
        task.dependencies.map((dependency) => ({
          tenantId: request.tenantId,
          projectId: request.projectId,
          predecessorTaskId: dependency.predecessorId,
          successorTaskId: task.id,
          type: dependency.type,
          lagWorkingDays: dependency.lagWorkingDays,
        })),
      );
      if (dependencyValues.length > 0) {
        await transaction.insert(taskDependencies).values(dependencyValues);
      }

      const resultRevision = actualRevision + 1n;
      await transaction
        .update(projects)
        .set({ revision: resultRevision, updatedAt: sql`now()` })
        .where(
          and(
            eq(projects.tenantId, request.tenantId),
            eq(projects.id, request.projectId),
            eq(projects.revision, actualRevision),
          ),
        );
      await transaction.insert(auditEvents).values({
        tenantId: request.tenantId,
        projectId: request.projectId,
        projectRevision: resultRevision,
        actorType: request.actor.type,
        actorId: request.actor.id,
        commandType: request.command.type,
        payload: {
          command: request.command,
          expectedRevision: request.expectedRevision.toString(),
          idempotencyKey: request.idempotencyKey,
        },
      });
      await transaction.insert(commandReceipts).values({
        tenantId: request.tenantId,
        projectId: request.projectId,
        idempotencyKey: request.idempotencyKey,
        requestHash: fingerprint,
        resultRevision,
      });

      return {
        projectId: request.projectId,
        revision: resultRevision,
        replayed: false,
      };
    });
  }
}
