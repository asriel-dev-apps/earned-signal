import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createProjectCommandService } from "@earned-signal/application";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  markScenarioPublished,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
  ProjectScenarioRepository,
  ScenarioRevisionConflictError,
  ScenarioStaleError,
  ScenarioTerminalError,
} from "../src/index.js";

describe("ProjectScenarioRepository", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  const actor = { type: "HUMAN" as const, id: "planner-001" };
  let client: Client;
  let repository: ProjectScenarioRepository;
  let projectRepository: ProjectRepository;
  let database: ReturnType<typeof createPersistenceDatabase>;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    database = createPersistenceDatabase(client);
    repository = new ProjectScenarioRepository(database);
    projectRepository = new ProjectRepository(database);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await stopContainer?.();
  });

  beforeEach(async () => {
    await client.query("truncate table tenants cascade");
    await projectRepository.save(demoProjectRecord);
  });

  it("creates and retrieves a tenant-scoped draft without changing Current revision", async () => {
    const created = await repository.create({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      name: "Recover launch date",
      baseProjectRevision: 1n,
      changes: [{ type: "task.update", taskId: demoProjectRecord.activities[2]!.id, durationWorkingDays: 5 }],
      actor,
    });

    expect(created).toMatchObject({
      name: "Recover launch date",
      status: "DRAFT",
      baseProjectRevision: 1n,
      revision: 1n,
      latestRun: null,
      publishedAt: null,
      discardedAt: null,
    });
    await expect(repository.load(created.tenantId, created.projectId, created.id)).resolves.toEqual(created);
    await expect(repository.list(created.tenantId, created.projectId)).resolves.toEqual([created]);
    await expect(
      repository.load("00000000-0000-4000-8000-ffffffffffff", created.projectId, created.id),
    ).resolves.toBeNull();
    await expect(
      client.query<{ revision: string }>("select revision::text as revision from projects where id = $1", [created.projectId]),
    ).resolves.toMatchObject({ rows: [{ revision: "1" }] });
  });

  it("invalidates the latest run after an edit and enforces scenario/project revisions", async () => {
    const scenario = await repository.create({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      name: "Capacity recovery",
      baseProjectRevision: 1n,
      changes: [],
      actor,
    });
    const run = await repository.saveRun({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedScenarioRevision: 1n,
      sourceProjectRevision: 1n,
      algorithmVersion: "schedule-v1",
      inputHash: "a".repeat(64),
      inputSnapshot: { statusDate: "2026-08-07", changes: [] },
      output: { finishDate: "2026-08-28" },
      actor,
    });
    expect(run.sourceScenarioRevision).toBe(1n);
    expect((await repository.load(scenario.tenantId, scenario.projectId, scenario.id))?.latestRun).toEqual(run);

    const edited = await repository.updateChanges({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedRevision: 1n,
      changes: [{ type: "resource.add", resourceId: "00000000-0000-4000-8000-000000000123" }],
      actor,
    });
    expect(edited).toMatchObject({ revision: 2n, latestRun: null });
    await expect(repository.updateChanges({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedRevision: 1n,
      changes: [],
      actor,
    })).rejects.toBeInstanceOf(ScenarioRevisionConflictError);

    await client.query("update projects set revision = 2 where id = $1", [scenario.projectId]);
    await expect(repository.saveRun({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedScenarioRevision: 2n,
      sourceProjectRevision: 1n,
      algorithmVersion: "schedule-v1",
      inputHash: "b".repeat(64),
      inputSnapshot: {},
      output: {},
      actor,
    })).rejects.toBeInstanceOf(ScenarioStaleError);
  });

  it("makes discarded scenarios terminal and appends ordered audit events", async () => {
    const scenario = await repository.create({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      name: "Discard me",
      baseProjectRevision: 1n,
      changes: [],
      actor,
    });
    const discarded = await repository.discard({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedRevision: 1n,
      actor,
    });
    expect(discarded).toMatchObject({ status: "DISCARDED", revision: 2n, discardedBy: actor.id });
    await expect(repository.updateChanges({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedRevision: 2n,
      changes: [],
      actor,
    })).rejects.toBeInstanceOf(ScenarioTerminalError);
    await expect(repository.listAuditEvents(scenario.tenantId, scenario.projectId, scenario.id)).resolves.toMatchObject([
      { eventType: "scenario.created", scenarioRevision: 1n },
      { eventType: "scenario.discarded", scenarioRevision: 2n },
    ]);
    const project = await client.query<{ revision: string }>("select revision::text as revision from projects where id = $1", [scenario.projectId]);
    expect(project.rows[0]?.revision).toBe("1");
  });

  it("marks a current, calculated draft as published inside the caller transaction", async () => {
    const scenario = await repository.create({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      name: "Publish me",
      baseProjectRevision: 1n,
      changes: [],
      actor,
    });
    await repository.saveRun({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedScenarioRevision: 1n,
      sourceProjectRevision: 1n,
      algorithmVersion: "schedule-v1",
      inputHash: "c".repeat(64),
      inputSnapshot: {},
      output: {},
      actor,
    });

    const published = await database.transaction((transaction) => markScenarioPublished(transaction, {
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedScenarioRevision: 1n,
      sourceProjectRevision: 1n,
      actor,
    }));

    expect(published).toMatchObject({ status: "PUBLISHED", revision: 2n, publishedBy: actor.id });
    expect(published.publishedAt).not.toBeNull();
    await expect(repository.discard({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedRevision: 2n,
      actor,
    })).rejects.toBeInstanceOf(ScenarioTerminalError);
  });

  it("atomically publishes stored Scenario changes into Current without changing Baseline", async () => {
    const task = demoProjectRecord.activities[2]!;
    const changes = [{
      type: "task.update" as const,
      taskId: task.id,
      changes: { durationWorkingDays: task.durationWorkingDays + 2 },
    }];
    const scenario = await repository.create({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      name: "Publish recovery",
      baseProjectRevision: 1n,
      changes,
      actor,
    });
    await repository.saveRun({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedScenarioRevision: 1n,
      sourceProjectRevision: 1n,
      algorithmVersion: "deterministic-trend-v1",
      inputHash: "d".repeat(64),
      inputSnapshot: { changes },
      output: { finish: "2026-08-31" },
      actor,
    });

    const service = createProjectCommandService(new PostgresProjectCommandUnitOfWork(database));
    const request = {
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      expectedRevision: 1n,
      idempotencyKey: "publish-scenario-recovery",
      actor,
      command: {
        type: "scenario.publish",
        scenarioId: scenario.id,
        scenarioRevision: "1",
        sourceProjectRevision: "1",
        changes,
      },
    } as const;
    const result = await service.execute(request);
    const replay = await service.execute(request);

    expect(result.revision).toBe(2n);
    expect(replay).toMatchObject({ revision: 2n, replayed: true });
    expect(await repository.load(scenario.tenantId, scenario.projectId, scenario.id)).toMatchObject({
      status: "PUBLISHED",
      revision: 2n,
    });
    const persisted = await projectRepository.load(scenario.tenantId, scenario.projectId);
    expect(persisted?.activities.find((activity) => activity.id === task.id)?.durationWorkingDays).toBe(task.durationWorkingDays + 2);
    expect(persisted?.baseline?.activities.find((activity) => activity.sourceActivityId === task.id)?.durationWorkingDays).toBe(
      demoProjectRecord.baseline?.activities.find((activity) => activity.sourceActivityId === task.id)?.durationWorkingDays,
    );
    expect(persisted?.auditEvents.at(-1)?.commandType).toBe("scenario.publish");
    expect(persisted?.auditEvents.filter((event) => event.commandType === "scenario.publish")).toHaveLength(1);
  });

  it("rolls back Scenario publication when the approved commands differ from the stored draft", async () => {
    const task = demoProjectRecord.activities[2]!;
    const storedChanges = [{
      type: "task.update" as const,
      taskId: task.id,
      changes: { durationWorkingDays: task.durationWorkingDays + 2 },
    }];
    const scenario = await repository.create({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      name: "Reject altered publication",
      baseProjectRevision: 1n,
      changes: storedChanges,
      actor,
    });
    await repository.saveRun({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      scenarioId: scenario.id,
      expectedScenarioRevision: 1n,
      sourceProjectRevision: 1n,
      algorithmVersion: "deterministic-trend-v1",
      inputHash: "e".repeat(64),
      inputSnapshot: { changes: storedChanges },
      output: { finish: "2026-08-31" },
      actor,
    });

    await expect(createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(database),
    ).execute({
      tenantId: scenario.tenantId,
      projectId: scenario.projectId,
      expectedRevision: 1n,
      idempotencyKey: "publish-altered-scenario",
      actor,
      command: {
        type: "scenario.publish",
        scenarioId: scenario.id,
        scenarioRevision: "1",
        sourceProjectRevision: "1",
        changes: [{
          type: "task.update",
          taskId: task.id,
          changes: { durationWorkingDays: task.durationWorkingDays + 3 },
        }],
      },
    })).rejects.toThrow("do not match");

    expect(await repository.load(scenario.tenantId, scenario.projectId, scenario.id)).toMatchObject({
      status: "DRAFT",
      revision: 1n,
    });
    const persisted = await projectRepository.load(scenario.tenantId, scenario.projectId);
    const projectRevision = await client.query<{ revision: string }>(
      "select revision::text as revision from projects where id = $1",
      [scenario.projectId],
    );
    expect(projectRevision.rows[0]?.revision).toBe("1");
    expect(persisted?.activities.find((activity) => activity.id === task.id)?.durationWorkingDays).toBe(task.durationWorkingDays);
    expect(persisted?.auditEvents.some((event) => event.commandType === "scenario.publish")).toBe(false);
  });
});
