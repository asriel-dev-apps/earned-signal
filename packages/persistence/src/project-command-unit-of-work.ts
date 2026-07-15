import { createHash } from "node:crypto";
import {
  ActualValueDecreaseError,
  IdempotencyConflictError,
  ProjectCommandValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
} from "@earned-signal/application";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  activities,
  auditEvents,
  commandReceipts,
  dependencies,
  directActualCosts,
  progressMeasurements,
  projectCalendars,
  projects,
  schema,
  wbsNodes,
  worklogs,
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

function asSafeNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceeds the safe application range`);
  }
  return result;
}

const POSTGRES_INTEGER_MAX = 2_147_483_647;

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

      const activityRows = await transaction
        .select({
          id: activities.id,
          wbsNodeId: activities.wbsNodeId,
          wbs: wbsNodes.code,
          wbsParentId: wbsNodes.parentId,
          name: activities.name,
          owner: activities.owner,
          durationWorkingDays: activities.durationWorkingDays,
          calendarId: activities.calendarId,
          constraintType: activities.constraintType,
          constraintDate: activities.constraintDate,
          budgetMinor: activities.budgetMinor,
          measurementMethod: activities.measurementMethod,
          sortOrder: activities.sortOrder,
        })
        .from(activities)
        .innerJoin(
          wbsNodes,
          and(
            eq(wbsNodes.tenantId, activities.tenantId),
            eq(wbsNodes.projectId, activities.projectId),
            eq(wbsNodes.id, activities.wbsNodeId),
          ),
        )
        .where(
          and(eq(activities.tenantId, request.tenantId), eq(activities.projectId, request.projectId)),
        )
        .orderBy(asc(activities.sortOrder));
      const wbsNodeRows = await transaction
        .select()
        .from(wbsNodes)
        .where(and(eq(wbsNodes.tenantId, request.tenantId), eq(wbsNodes.projectId, request.projectId)))
        .orderBy(asc(wbsNodes.sortOrder));
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
      const dependencyRows = await transaction
        .select()
        .from(dependencies)
        .where(
          and(
            eq(dependencies.tenantId, request.tenantId),
            eq(dependencies.projectId, request.projectId),
          ),
        );
      const measurementRows = await transaction
        .select()
        .from(progressMeasurements)
        .where(
          and(
            eq(progressMeasurements.tenantId, request.tenantId),
            eq(progressMeasurements.projectId, request.projectId),
            lte(progressMeasurements.measurementDate, projectRow.statusDate),
          ),
        )
        .orderBy(asc(progressMeasurements.measurementDate));
      const worklogRows = await transaction
        .select()
        .from(worklogs)
        .where(and(eq(worklogs.tenantId, request.tenantId), eq(worklogs.projectId, request.projectId)));
      const costRows = await transaction
        .select()
        .from(directActualCosts)
        .where(
          and(
            eq(directActualCosts.tenantId, request.tenantId),
            eq(directActualCosts.projectId, request.projectId),
          ),
        );

      const dependenciesByActivity = new Map<
        string,
        Array<{ predecessorId: string; type: "FS" | "SS" | "FF" | "SF"; lagWorkingDays: number }>
      >();
      for (const dependency of dependencyRows) {
        const entries = dependenciesByActivity.get(dependency.successorActivityId) ?? [];
        entries.push({
          predecessorId: dependency.predecessorActivityId,
          type: dependency.type,
          lagWorkingDays: dependency.lagWorkingDays,
        });
        dependenciesByActivity.set(dependency.successorActivityId, entries);
      }
      const progressByActivity = new Map<string, number>();
      for (const measurement of measurementRows) {
        progressByActivity.set(measurement.activityId, measurement.progressBasisPoints / 100);
      }
      const minutesByActivity = new Map<string, number>();
      for (const worklog of worklogRows) {
        minutesByActivity.set(
          worklog.activityId,
          (minutesByActivity.get(worklog.activityId) ?? 0) + worklog.actualMinutes,
        );
      }
      const costByActivity = new Map<string, bigint>();
      for (const cost of costRows) {
        costByActivity.set(
          cost.activityId,
          (costByActivity.get(cost.activityId) ?? 0n) + cost.amountMinor,
        );
      }

      const current: ProjectState = {
        id: projectRow.id,
        name: projectRow.name,
        projectStart: projectRow.projectStart,
        statusDate: projectRow.statusDate,
        currency: projectRow.currency,
        defaultCalendarId: projectRow.defaultCalendarId,
        calendars: calendarRows.map((calendar) => ({
          id: calendar.id,
          name: calendar.name,
          workingWeekdays: calendar.workingWeekdays,
          nonWorkingDates: calendar.nonWorkingDates,
        })),
        wbsGroups: wbsNodeRows
          .filter((node) => !activityRows.some((activity) => activity.wbsNodeId === node.id))
          .map((node) => ({
            id: node.id,
            parentId: node.parentId,
            code: node.code,
            name: node.name,
          })),
        tasks: activityRows.map((activity) => ({
          id: activity.id,
          wbs: activity.wbs,
          wbsParentId: activity.wbsParentId,
          name: activity.name,
          owner: activity.owner,
          durationWorkingDays: activity.durationWorkingDays,
          measurementMethod: activity.measurementMethod,
          calendarId: activity.calendarId,
          dependencies: dependenciesByActivity.get(activity.id) ?? [],
          constraint:
            activity.constraintType === null || activity.constraintDate === null
              ? null
              : { type: activity.constraintType, date: activity.constraintDate },
          budget: asSafeNumber(activity.budgetMinor, `Budget for ${activity.id}`),
          progressPercent: progressByActivity.get(activity.id) ?? 0,
          actualCost: asSafeNumber(costByActivity.get(activity.id) ?? 0n, `Actual cost for ${activity.id}`),
          actualMinutes: minutesByActivity.get(activity.id) ?? 0,
        })),
      };
      const next = transition(current);
      const currentById = new Map(current.tasks.map((task) => [task.id, task]));
      const nextById = new Map(next.tasks.map((task) => [task.id, task]));

      for (const task of next.tasks) {
        const previous = currentById.get(task.id);
        if (previous !== undefined && task.actualMinutes < previous.actualMinutes) {
          throw new ActualValueDecreaseError("actualMinutes");
        }
        if (previous !== undefined && task.actualCost < previous.actualCost) {
          throw new ActualValueDecreaseError("actualCost");
        }
      }
      for (const task of current.tasks) {
        if (
          !nextById.has(task.id) &&
          (task.actualMinutes > 0 || task.actualCost > 0)
        ) {
          throw new ProjectCommandValidationError(
            `Task ${task.id} with actuals cannot be deleted`,
          );
        }
      }

      await transaction
        .delete(dependencies)
        .where(
          and(
            eq(dependencies.tenantId, request.tenantId),
            eq(dependencies.projectId, request.projectId),
          ),
        );

      for (const activity of activityRows) {
        if (!nextById.has(activity.id)) {
          await transaction
            .delete(activities)
            .where(
              and(
                eq(activities.tenantId, request.tenantId),
                eq(activities.projectId, request.projectId),
                eq(activities.id, activity.id),
              ),
            );
          await transaction
            .delete(wbsNodes)
            .where(
              and(
                eq(wbsNodes.tenantId, request.tenantId),
                eq(wbsNodes.projectId, request.projectId),
                eq(wbsNodes.id, activity.wbsNodeId),
              ),
            );
        }
      }

      const wbsNodeByActivity = new Map(activityRows.map((row) => [row.id, row.wbsNodeId]));
      for (const [sortOrder, task] of next.tasks.entries()) {
        let wbsNodeId = wbsNodeByActivity.get(task.id);
        if (wbsNodeId === undefined) {
          wbsNodeId = crypto.randomUUID();
          await transaction.insert(wbsNodes).values({
            id: wbsNodeId,
            tenantId: request.tenantId,
            projectId: request.projectId,
            parentId: task.wbsParentId,
            code: task.wbs,
            name: task.name,
            sortOrder,
          });
          await transaction.insert(activities).values({
            id: task.id,
            tenantId: request.tenantId,
            projectId: request.projectId,
            wbsNodeId,
            name: task.name,
            owner: task.owner,
            durationWorkingDays: task.durationWorkingDays,
            calendarId: task.calendarId,
            constraintType: task.constraint?.type ?? null,
            constraintDate: task.constraint?.date ?? null,
            budgetMinor: BigInt(task.budget),
            measurementMethod: task.measurementMethod,
            sortOrder,
          });
        } else {
          await transaction
            .update(wbsNodes)
            .set({
              parentId: task.wbsParentId,
              code: task.wbs,
              name: task.name,
              sortOrder,
            })
            .where(
              and(
                eq(wbsNodes.tenantId, request.tenantId),
                eq(wbsNodes.projectId, request.projectId),
                eq(wbsNodes.id, wbsNodeId),
              ),
            );
          await transaction
            .update(activities)
            .set({
              name: task.name,
              owner: task.owner,
              durationWorkingDays: task.durationWorkingDays,
              calendarId: task.calendarId,
              constraintType: task.constraint?.type ?? null,
              constraintDate: task.constraint?.date ?? null,
              budgetMinor: BigInt(task.budget),
              measurementMethod: task.measurementMethod,
              sortOrder,
            })
            .where(
              and(
                eq(activities.tenantId, request.tenantId),
                eq(activities.projectId, request.projectId),
                eq(activities.id, task.id),
              ),
            );
        }

        for (const dependency of task.dependencies) {
          await transaction.insert(dependencies).values({
            tenantId: request.tenantId,
            projectId: request.projectId,
            predecessorActivityId: dependency.predecessorId,
            successorActivityId: task.id,
            type: dependency.type,
            lagWorkingDays: dependency.lagWorkingDays,
          });
        }

        await transaction
          .insert(progressMeasurements)
          .values({
            tenantId: request.tenantId,
            projectId: request.projectId,
            activityId: task.id,
            measurementDate: projectRow.statusDate,
            method: task.measurementMethod,
            progressBasisPoints: Math.round(task.progressPercent * 100),
          })
          .onConflictDoUpdate({
            target: [
              progressMeasurements.tenantId,
              progressMeasurements.projectId,
              progressMeasurements.activityId,
              progressMeasurements.measurementDate,
            ],
            set: {
              method: task.measurementMethod,
              progressBasisPoints: Math.round(task.progressPercent * 100),
              recordedAt: sql`now()`,
            },
          });

        const previous = currentById.get(task.id);
        const previousMinutes = previous?.actualMinutes ?? 0;
        const additionalMinutes = task.actualMinutes - previousMinutes;
        if (additionalMinutes > POSTGRES_INTEGER_MAX) {
          throw new ProjectCommandValidationError(
            `Actual effort change must not exceed ${POSTGRES_INTEGER_MAX} minutes`,
          );
        }
        if (additionalMinutes > 0) {
          await transaction.insert(worklogs).values({
            tenantId: request.tenantId,
            projectId: request.projectId,
            activityId: task.id,
            workDate: projectRow.statusDate,
            actualMinutes: additionalMinutes,
            rateMinorPerHour: "0.000000",
            personRef: request.actor.id,
          });
        }
        const previousCost = previous?.actualCost ?? 0;
        const additionalCost = task.actualCost - previousCost;
        if (additionalCost > 0) {
          await transaction.insert(directActualCosts).values({
            tenantId: request.tenantId,
            projectId: request.projectId,
            activityId: task.id,
            costDate: projectRow.statusDate,
            amountMinor: BigInt(additionalCost),
            description: `${request.command.type} via ${request.actor.type.toLowerCase()}`,
          });
        }
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
