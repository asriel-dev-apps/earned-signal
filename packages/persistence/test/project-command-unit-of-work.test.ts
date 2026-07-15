import {
  IdempotencyConflictError,
  ProjectCommandValidationError,
  ProjectVersionConflictError,
  createProjectCommandService,
} from "@earned-signal/application";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
} from "../src/index.js";

describe("PostgresProjectCommandUnitOfWork", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let connectionString: string;
  let repository: ProjectRepository;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    connectionString = started.getConnectionUri();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString });
    await client.connect();
    await migratePersistenceDatabase(client);
    const database = createPersistenceDatabase(client);
    repository = new ProjectRepository(database);
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  beforeEach(async () => {
    await client.query("truncate table tenants cascade");
    await repository.save(demoProjectRecord);
  });

  it("atomically persists a command, revision, audit event, and idempotency receipt", async () => {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
    const task = demoProjectRecord.activities[2]!;

    const result = await service.execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "progress-A3-2026-08-07",
      actor: { type: "HUMAN", id: "user-001" },
      command: {
        type: "task.update",
        taskId: task.id,
        changes: { progressPercent: 75, actualMinutes: 4_200 },
      },
    });

    expect(result).toEqual({
      projectId: demoProjectRecord.project.id,
      revision: 2n,
      replayed: false,
    });

    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(reloaded?.project.revision).toBe(2n);
    expect(
      reloaded?.progressMeasurements.find((measurement) => measurement.activityId === task.id),
    ).toMatchObject({ progressBasisPoints: 7_500 });
    expect(
      reloaded?.worklogs
        .filter((worklog) => worklog.activityId === task.id)
        .reduce((total, worklog) => total + worklog.actualMinutes, 0),
    ).toBe(4_200);
    expect(reloaded?.auditEvents.at(-1)).toMatchObject({
      projectRevision: 2n,
      actorType: "HUMAN",
      actorId: "user-001",
      commandType: "task.update",
    });
  });

  it("atomically replaces assignments and records the plan change", async () => {
    const unchangedResourceId = demoProjectRecord.resources[2]!.id;
    await client.query(
      "update resources set updated_at = '2000-01-01T00:00:00Z' where tenant_id = $1 and project_id = $2 and id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, unchangedResourceId],
    );
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
    const taskId = demoProjectRecord.activities[0]!.id;
    const assignments = [
      { resourceId: demoProjectRecord.resources[0]!.id, unitsPercent: 50 },
      { resourceId: demoProjectRecord.resources[1]!.id, unitsPercent: 25 },
    ];

    await service.execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "replace-activity-assignments",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "assignment.replace", taskId, assignments },
    });

    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(
      reloaded?.assignments
        .filter((assignment) => assignment.activityId === taskId)
        .map(({ resourceId, unitsPercent }) => ({ resourceId, unitsPercent })),
    ).toEqual(assignments);
    expect(reloaded?.project.revision).toBe(2n);
    expect(reloaded?.auditEvents.at(-1)).toMatchObject({
      actorType: "HUMAN",
      actorId: "user-001",
      commandType: "assignment.replace",
      projectRevision: 2n,
    });
    const unchangedResource = await client.query<{ updated_at: Date }>(
      "select updated_at from resources where tenant_id = $1 and project_id = $2 and id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, unchangedResourceId],
    );
    expect(unchangedResource.rows[0]?.updated_at.toISOString()).toBe("2000-01-01T00:00:00.000Z");
  });

  it("publishes Current as the next immutable Baseline version", async () => {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
    await service.execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "publish-baseline-v2",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "baseline.publish", label: "Recovery plan" },
    });
    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(reloaded?.baseline?.version).toMatchObject({
      version: 2,
      label: "Recovery plan",
      approvedBy: "user-001",
    });
    expect(reloaded?.baseline?.activities[2]).toMatchObject({
      sourceActivityId: demoProjectRecord.activities[2]!.id,
      durationWorkingDays: 7,
    });
    expect(reloaded?.baseline?.skills).toEqual(
      demoProjectRecord.skills.map(({ id: sourceSkillId, name }) =>
        expect.objectContaining({ sourceSkillId, name }),
      ),
    );
    expect(reloaded?.baseline?.resources).toEqual(
      demoProjectRecord.resources.map(({ id: sourceResourceId, name }) =>
        expect.objectContaining({ sourceResourceId, name }),
      ),
    );
    expect(reloaded?.baseline?.resourceSkills).toHaveLength(demoProjectRecord.resourceSkills.length);
    expect(reloaded?.baseline?.activitySkillRequirements).toHaveLength(
      demoProjectRecord.activitySkillRequirements.length,
    );
    expect(reloaded?.baseline?.assignments).toHaveLength(demoProjectRecord.assignments.length);
    expect(reloaded?.auditEvents.at(-1)).toMatchObject({
      commandType: "baseline.publish",
      projectRevision: 2n,
    });
  });

  it("preserves a task's 0/100 measurement method during an unrelated command", async () => {
    const zeroHundredTask = demoProjectRecord.activities[8]!;
    await client.query(
      "update activities set measurement_method = 'ZERO_HUNDRED' where tenant_id = $1 and project_id = $2 and id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, zeroHundredTask.id],
    );
    await client.query(
      "update progress_measurements set method = 'ZERO_HUNDRED' where tenant_id = $1 and project_id = $2 and activity_id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, zeroHundredTask.id],
    );
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );

    await service.execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "preserve-zero-hundred",
      actor: { type: "HUMAN", id: "user-001" },
      command: {
        type: "task.update",
        taskId: demoProjectRecord.activities[0]!.id,
        changes: { owner: "New owner" },
      },
    });

    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(
      reloaded?.activities.find((activity) => activity.id === zeroHundredTask.id),
    ).toMatchObject({ measurementMethod: "ZERO_HUNDRED" });
    expect(
      reloaded?.progressMeasurements.find(
        (measurement) => measurement.activityId === zeroHundredTask.id,
      ),
    ).toMatchObject({ method: "ZERO_HUNDRED", progressBasisPoints: 0 });
  });

  it("replays the original result without double-counting actual effort", async () => {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
    const task = demoProjectRecord.activities[2]!;
    const request = {
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "replay-progress-A3",
      actor: { type: "AGENT" as const, id: "agent-001" },
      command: {
        type: "task.update" as const,
        taskId: task.id,
        changes: { actualMinutes: 4_200 },
      },
    };

    await service.execute(request);
    const replay = await service.execute(request);

    expect(replay).toEqual({
      projectId: demoProjectRecord.project.id,
      revision: 2n,
      replayed: true,
    });
    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(
      reloaded?.worklogs
        .filter((worklog) => worklog.activityId === task.id)
        .reduce((total, worklog) => total + worklog.actualMinutes, 0),
    ).toBe(4_200);
    expect(reloaded?.auditEvents).toHaveLength(2);
  });

  it("rejects an idempotency key reused for a different command", async () => {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
    const task = demoProjectRecord.activities[2]!;
    const request = {
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "same-key",
      actor: { type: "HUMAN" as const, id: "user-001" },
      command: {
        type: "task.update" as const,
        taskId: task.id,
        changes: { progressPercent: 70 },
      },
    };
    await service.execute(request);

    await expect(
      service.execute({
        ...request,
        command: { ...request.command, changes: { progressPercent: 80 } },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(
      reloaded?.progressMeasurements.find((measurement) => measurement.activityId === task.id),
    ).toMatchObject({ progressBasisPoints: 7_000 });
    expect(reloaded?.project.revision).toBe(2n);
  });

  it("rejects a stale revision without changing project state or audit", async () => {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );

    await expect(
      service.execute({
        tenantId: demoProjectRecord.tenant.id,
        projectId: demoProjectRecord.project.id,
        expectedRevision: 0n,
        idempotencyKey: "stale-command",
        actor: { type: "HUMAN", id: "user-001" },
        command: {
          type: "task.update",
          taskId: demoProjectRecord.activities[0]!.id,
          changes: { name: "Must not persist" },
        },
      }),
    ).rejects.toBeInstanceOf(ProjectVersionConflictError);

    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(reloaded?.project.revision).toBe(1n);
    expect(reloaded?.activities[0]?.name).toBe("Confirm launch requirements");
    expect(reloaded?.auditEvents).toHaveLength(1);
  });

  it("persists a task with hierarchy, calendar, constraint, and multiple typed dependencies", async () => {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
    const taskId = "30000000-0000-4000-8000-000000000099";
    const predecessorId = demoProjectRecord.activities[8]!.id;
    const secondPredecessorId = demoProjectRecord.activities[7]!.id;
    const parentId = demoProjectRecord.wbsNodes.find((node) => node.code === "3")!.id;

    await service.execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "add-post-launch-review",
      actor: { type: "HUMAN", id: "user-001" },
      command: {
        type: "task.add",
        task: {
          id: taskId,
          wbs: "4.1",
          wbsParentId: parentId,
          name: "Post-launch review",
          owner: "Maya Chen",
          durationWorkingDays: 2,
          measurementMethod: "PHYSICAL_PERCENT",
          calendarId: "support",
          dependencies: [
            { predecessorId, type: "SS", lagWorkingDays: 1 },
            { predecessorId: secondPredecessorId, type: "FF", lagWorkingDays: 2 },
          ],
          constraint: { type: "FINISH_NO_LATER_THAN", date: "2026-09-30" },
          requiredSkillIds: [demoProjectRecord.skills[0]!.id],
          budget: 200_000,
          progressPercent: 0,
          actualCost: 0,
          actualMinutes: 0,
        },
      },
    });

    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(reloaded?.activities.find((activity) => activity.id === taskId)).toMatchObject({
      name: "Post-launch review",
      calendarId: "support",
      constraintType: "FINISH_NO_LATER_THAN",
      constraintDate: "2026-09-30",
      budgetMinor: 200_000n,
    });
    expect(
      reloaded?.wbsNodes.find((node) => node.id === reloaded.activities.find((activity) => activity.id === taskId)?.wbsNodeId),
    ).toMatchObject({ parentId });
    expect(
      reloaded?.dependencies
        .filter((dependency) => dependency.successorActivityId === taskId)
        .map(({ predecessorActivityId, type, lagWorkingDays }) => ({
          predecessorActivityId,
          type,
          lagWorkingDays,
        }))
        .sort((left, right) => left.predecessorActivityId.localeCompare(right.predecessorActivityId)),
    ).toEqual([
      { predecessorActivityId: secondPredecessorId, type: "FF", lagWorkingDays: 2 },
      { predecessorActivityId: predecessorId, type: "SS", lagWorkingDays: 1 },
    ]);
  });

  it("deletes a task without actuals while preserving its approved baseline snapshot", async () => {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
    const taskId = demoProjectRecord.activities[8]!.id;

    await service.execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "delete-launch-task",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "task.delete", taskId },
    });

    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(reloaded?.activities.some((activity) => activity.id === taskId)).toBe(false);
    expect(
      reloaded?.baseline?.activities.some((activity) => activity.sourceActivityId === taskId),
    ).toBe(true);
  });

  it("rejects deletion of a task with actuals before changing persisted state", async () => {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
    const taskId = demoProjectRecord.activities[8]!.id;

    await service.execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "record-launch-effort",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "task.update", taskId, changes: { actualMinutes: 60 } },
    });

    await expect(
      service.execute({
        tenantId: demoProjectRecord.tenant.id,
        projectId: demoProjectRecord.project.id,
        expectedRevision: 2n,
        idempotencyKey: "unsafe-delete",
        actor: { type: "HUMAN", id: "user-001" },
        command: { type: "task.delete", taskId },
      }),
    ).rejects.toBeInstanceOf(ProjectCommandValidationError);

    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(reloaded?.activities.some((activity) => activity.id === taskId)).toBe(true);
    expect(reloaded?.project.revision).toBe(2n);
    expect(reloaded?.auditEvents).toHaveLength(2);
  });

  it("rejects an actual-effort delta outside the PostgreSQL integer range", async () => {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );

    await expect(
      service.execute({
        tenantId: demoProjectRecord.tenant.id,
        projectId: demoProjectRecord.project.id,
        expectedRevision: 1n,
        idempotencyKey: "oversized-worklog-delta",
        actor: { type: "HUMAN", id: "user-001" },
        command: {
          type: "task.update",
          taskId: demoProjectRecord.activities[8]!.id,
          changes: { actualMinutes: 2_147_483_648 },
        },
      }),
    ).rejects.toThrow("Actual effort change must not exceed 2147483647 minutes");

    const reloaded = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(reloaded?.project.revision).toBe(1n);
    expect(reloaded?.auditEvents).toHaveLength(1);
  });

  it("serializes concurrent retries so only one command mutates the project", async () => {
    const concurrentClient = new Client({ connectionString });
    await concurrentClient.connect();
    try {
      const firstService = createProjectCommandService(
        new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
      );
      const secondService = createProjectCommandService(
        new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(concurrentClient)),
      );
      const taskId = demoProjectRecord.activities[2]!.id;
      const request = {
        tenantId: demoProjectRecord.tenant.id,
        projectId: demoProjectRecord.project.id,
        expectedRevision: 1n,
        idempotencyKey: "concurrent-retry",
        actor: { type: "AGENT" as const, id: "agent-001" },
        command: {
          type: "task.update" as const,
          taskId,
          changes: { actualMinutes: 4_200 },
        },
      };

      const results = await Promise.all([
        firstService.execute(request),
        secondService.execute(request),
      ]);

      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      const reloaded = await repository.load(
        demoProjectRecord.tenant.id,
        demoProjectRecord.project.id,
      );
      expect(
        reloaded?.worklogs
          .filter((worklog) => worklog.activityId === taskId)
          .reduce((total, worklog) => total + worklog.actualMinutes, 0),
      ).toBe(4_200);
      expect(reloaded?.auditEvents).toHaveLength(2);
    } finally {
      await concurrentClient.end();
    }
  });
});
