import { projectWbsGrid } from "@vecta/application";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  createSeedProjectRecord,
  demoProjectRecord,
  migratePersistenceDatabase,
  ProjectRepository,
  ProjectWorkspaceRepository,
} from "../src/index.js";

describe("ProjectRepository", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let repository: ProjectRepository;
  let workspaceRepository: ProjectWorkspaceRepository;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    const database = createPersistenceDatabase(client);
    repository = new ProjectRepository(database);
    workspaceRepository = new ProjectWorkspaceRepository(database);
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  beforeEach(async () => {
    await client.query("truncate table tenants cascade");
    await repository.save(demoProjectRecord);
  });

  it("saves and reloads the tenant-scoped demo project", async () => {
    const loaded = await repository.load(demoProjectRecord.project.tenantId, demoProjectRecord.project.id);

    expect(loaded?.project.revision).toBe(1n);
    expect(loaded?.tasks).toHaveLength(demoProjectRecord.tasks.length);
    expect(loaded?.members).toHaveLength(demoProjectRecord.members.length);
    expect(loaded?.processes).toHaveLength(demoProjectRecord.processes.length);
    expect(loaded?.products).toHaveLength(demoProjectRecord.products.length);
    expect(loaded?.dependencies).toHaveLength(demoProjectRecord.dependencies.length);
    expect(loaded?.auditEvents).toEqual(demoProjectRecord.auditEvents);

    const leaf = demoProjectRecord.tasks.find((task) => task.parentTaskId !== null)!;
    expect(loaded?.tasks.find((task) => task.id === leaf.id)).toMatchObject({
      parentTaskId: leaf.parentTaskId,
      plannedEffortMinutes: leaf.plannedEffortMinutes,
      progressBasisPoints: leaf.progressBasisPoints,
      dailyPlan: leaf.dailyPlan,
    });

    await expect(
      repository.load("00000000-0000-4000-8000-ffffffffffff", demoProjectRecord.project.id),
    ).resolves.toBeNull();
  });

  it("loads Current and revision for the workspace", async () => {
    const workspace = await workspaceRepository.load(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
    );
    expect(workspace?.revision).toBe(1n);
    expect(workspace?.current.id).toBe(demoProjectRecord.project.id);
    expect(workspace?.current.tasks).toHaveLength(demoProjectRecord.tasks.length);
    expect(workspace?.current.members).toHaveLength(demoProjectRecord.members.length);
  });

  it("projects a flat WBS grid with derived columns and a rollup", async () => {
    const workspace = await workspaceRepository.load(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
    );
    const projection = projectWbsGrid(workspace!.current);
    expect(projection.rows).toHaveLength(demoProjectRecord.tasks.length);
    expect(projection.rows[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        plannedEffortDays: expect.any(Number),
        plannedEffortHours: expect.any(Number),
        plannedEarnedHours: expect.any(Number),
        plannedProgress: expect.any(Number),
        earnedEffortHours: expect.any(Number),
        actualEffortHours: expect.any(Number),
        costVarianceHours: expect.any(Number),
        status: expect.any(String),
      }),
    );
    expect(Object.keys(projection.rollup)).toEqual([
      "bac",
      "pv",
      "ev",
      "ac",
      "sv",
      "cv",
      "spi",
      "cpi",
    ]);
  });
});

describe("createSeedProjectRecord", () => {
  it("is deterministic for the same seed", () => {
    expect(createSeedProjectRecord()).toEqual(createSeedProjectRecord());
  });

  it("produces a two-level hierarchy with the requested shape", () => {
    const record = createSeedProjectRecord({ parentCount: 10, subtasksPerParent: 4 });
    expect(record.tasks).toHaveLength(10 + 10 * 4);
    expect(record.tasks.filter((task) => task.parentTaskId === null)).toHaveLength(10);
    expect(record.tasks.every((task) => task.name.trim().length > 0)).toBe(true);
  });
});
