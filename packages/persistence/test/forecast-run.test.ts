import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  ForecastRunIdempotencyConflictError,
  ForecastRunStaleError,
  ForecastRunTransitionError,
  migratePersistenceDatabase,
  ProjectForecastRunRepository,
  ProjectRepository,
  ProjectScenarioRepository,
} from "../src/index.js";

describe("ProjectForecastRunRepository", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  const actor = { type: "HUMAN" as const, id: "planner-001" };
  const system = { type: "SYSTEM" as const, id: "forecast-queue" };
  let client: Client;
  let repository: ProjectForecastRunRepository;
  let scenarios: ProjectScenarioRepository;
  let projects: ProjectRepository;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    const database = createPersistenceDatabase(client);
    repository = new ProjectForecastRunRepository(database);
    scenarios = new ProjectScenarioRepository(database);
    projects = new ProjectRepository(database);
  }, 60_000);

  afterAll(async () => { await client?.end(); await stopContainer?.(); });
  beforeEach(async () => { await client.query("truncate table tenants cascade"); await projects.save(demoProjectRecord); });

  async function createScenario() {
    return scenarios.create({ tenantId: demoProjectRecord.tenant.id, projectId: demoProjectRecord.project.id, name: "Risk case", baseProjectRevision: 1n, changes: [], actor });
  }

  async function createRun(scenarioId: string, idempotencyKey = "forecast-1", requestHash = "a".repeat(64)) {
    return repository.create({ tenantId: demoProjectRecord.tenant.id, projectId: demoProjectRecord.project.id, scenarioId, sourceProjectRevision: 1n, sourceScenarioRevision: 1n, idempotencyKey, requestHash, input: { contractVersion: "forecast.v1", seed: 42 }, actor });
  }

  it("creates, replays, lists, loads, and audits a revision-pinned immutable request", async () => {
    const scenario = await createScenario();
    const created = await createRun(scenario.id);
    await expect(createRun(scenario.id)).resolves.toEqual({ run: created.run, replayed: true });
    await expect(repository.load(created.run.tenantId, created.run.projectId, scenario.id, created.run.id)).resolves.toEqual(created.run);
    await expect(repository.list(created.run.tenantId, created.run.projectId, scenario.id)).resolves.toEqual([created.run]);
    await expect(repository.load("00000000-0000-4000-8000-ffffffffffff", created.run.projectId, scenario.id, created.run.id)).resolves.toBeNull();
    await expect(repository.listAuditEvents(created.run.tenantId, created.run.projectId, scenario.id, created.run.id)).resolves.toMatchObject([{ eventType: "forecast_run.created", actor }]);
    await expect(createRun(scenario.id, "forecast-1", "b".repeat(64))).rejects.toBeInstanceOf(ForecastRunIdempotencyConflictError);
  });

  it("is safe under at-least-once start and completion replay", async () => {
    const scenario = await createScenario();
    const created = (await createRun(scenario.id)).run;
    const identity = { tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, forecastRunId: created.id };
    const running = await repository.markRunning({ ...identity, actor: system });
    await expect(repository.markRunning({ ...identity, actor: system })).resolves.toEqual(running);
    const completed = await repository.complete({ ...identity, status: "READY", algorithmVersion: "earned-signal-monte-carlo-1", output: { iterations: 2_000 }, actor: system });
    expect(completed).toMatchObject({ accepted: true, run: { status: "READY" }, result: { status: "READY" } });
    await expect(repository.list(created.tenantId, created.projectId, scenario.id)).resolves.toEqual([completed.run]);
    await expect(repository.complete({ ...identity, status: "FAILED", algorithmVersion: "queue-retry", output: { error: "late" }, actor: system })).resolves.toEqual({ ...completed, accepted: false });
    await scenarios.updateChanges({ tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, expectedRevision: 1n, changes: [{ type: "task.update", taskId: demoProjectRecord.activities[0]!.id, changes: { budget: 1 } }], actor });
    await expect(repository.complete({ ...identity, status: "READY", algorithmVersion: "queue-retry", output: {}, actor: system })).resolves.toMatchObject({ accepted: false, run: { status: "READY" } });
    await expect(repository.listAuditEvents(created.tenantId, created.projectId, scenario.id, created.id)).resolves.toHaveLength(3);
    await expect(client.query("update forecast_runs set input = '{}' where id = $1", [created.id])).rejects.toMatchObject({ code: "55000" });
    await expect(client.query("update forecast_run_results set output = '{}' where id = $1", [completed.result.id])).rejects.toMatchObject({ code: "55000" });
    await expect(client.query("delete from forecast_run_audit_events where forecast_run_id = $1", [created.id])).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects stale revisions and requires RUNNING before completion", async () => {
    const scenario = await createScenario();
    await expect(repository.create({ tenantId: demoProjectRecord.tenant.id, projectId: demoProjectRecord.project.id, scenarioId: scenario.id, sourceProjectRevision: 1n, sourceScenarioRevision: 2n, idempotencyKey: "stale", requestHash: "a".repeat(64), input: {}, actor })).rejects.toBeInstanceOf(ForecastRunStaleError);
    const created = (await createRun(scenario.id)).run;
    await expect(repository.complete({ tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, forecastRunId: created.id, status: "READY", algorithmVersion: "v1", output: {}, actor: system })).rejects.toBeInstanceOf(ForecastRunTransitionError);
    await repository.markRunning({ tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, forecastRunId: created.id, actor: system });
    await scenarios.updateChanges({ tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, expectedRevision: 1n, changes: [{ type: "task.update", taskId: demoProjectRecord.activities[0]!.id, changes: { budget: 1 } }], actor });
    await expect(repository.complete({ tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, forecastRunId: created.id, status: "READY", algorithmVersion: "v1", output: {}, actor: system })).rejects.toBeInstanceOf(ForecastRunStaleError);
    await expect(repository.load(created.tenantId, created.projectId, scenario.id, created.id)).resolves.toMatchObject({ status: "RUNNING", latestResult: null });
    const identity = { tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, forecastRunId: created.id };
    const failed = await repository.complete({ ...identity, status: "FAILED", algorithmVersion: "queue-v1", output: { code: "STALE_SOURCE" }, actor: system });
    expect(failed).toMatchObject({ accepted: true, run: { status: "FAILED" }, result: { status: "FAILED" } });
    await expect(repository.complete({ ...identity, status: "FAILED", algorithmVersion: "queue-v1", output: { code: "REPLAY" }, actor: system })).resolves.toEqual({ ...failed, accepted: false });
  });

  it("can record a replay-safe FAILED result after its source becomes stale", async () => {
    const scenario = await createScenario();
    const created = (await createRun(scenario.id)).run;
    await scenarios.updateChanges({ tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, expectedRevision: 1n, changes: [{ type: "task.update", taskId: demoProjectRecord.activities[0]!.id, changes: { budget: 1 } }], actor });
    const identity = { tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, forecastRunId: created.id };
    const failed = await repository.complete({ ...identity, status: "FAILED", algorithmVersion: "queue-v1", output: { code: "STALE_SOURCE" }, actor: system });
    expect(failed).toMatchObject({ accepted: true, run: { status: "FAILED", startedAt: expect.any(String) }, result: { status: "FAILED" } });
    await expect(repository.complete({ ...identity, status: "FAILED", algorithmVersion: "queue-v1", output: { code: "REPLAY" }, actor: system })).resolves.toEqual({ ...failed, accepted: false });
  });

  it("enforces tenant/scenario child isolation and rolls back a failed terminal write", async () => {
    const scenario = await createScenario();
    const created = (await createRun(scenario.id)).run;
    await expect(client.query(`insert into forecast_run_results (tenant_id, project_id, scenario_id, forecast_run_id, status, algorithm_version, output, actor_type, actor_id) values ($1,$2,$3,$4,'READY','v1','{}','SYSTEM','x')`, ["00000000-0000-4000-8000-ffffffffffff", created.projectId, scenario.id, created.id])).rejects.toMatchObject({ code: "23503" });
    const identity = { tenantId: created.tenantId, projectId: created.projectId, scenarioId: scenario.id, forecastRunId: created.id };
    await repository.markRunning({ ...identity, actor: system });
    await expect(repository.complete({ ...identity, status: "READY", algorithmVersion: "", output: {}, actor: system })).rejects.toThrow("algorithm version");
    await expect(repository.load(created.tenantId, created.projectId, scenario.id, created.id)).resolves.toMatchObject({ status: "RUNNING", latestResult: null });
  });
});
