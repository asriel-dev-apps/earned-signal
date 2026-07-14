import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  ProjectRepository,
} from "../src/index.js";

describe("ProjectRepository", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let repository: ProjectRepository;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    repository = new ProjectRepository(createPersistenceDatabase(client));
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  it("saves and reloads the tenant-scoped demo project and its frozen baseline", async () => {
    await repository.save(demoProjectRecord);

    const loaded = await repository.load(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
    );

    expect(loaded).toEqual(demoProjectRecord);
    expect(loaded?.wbsNodes).toHaveLength(12);
    expect(loaded?.activities).toHaveLength(9);
    expect(loaded?.dependencies).toHaveLength(8);
    expect(loaded?.baseline?.activities).toHaveLength(9);
    expect(loaded?.baseline?.wbsNodes).toHaveLength(12);
    expect(loaded?.baseline?.dependencies).toHaveLength(8);
    expect(loaded?.baseline?.activities[0]).toMatchObject({
      baselineStart: "2026-07-13",
      baselineFinish: "2026-07-17",
      budgetMinor: 600_000n,
    });
    expect(loaded?.worklogs[0]?.actualMinutes).toBe(2_760);
    expect(loaded?.directActualCosts[0]?.amountMinor).toBe(650_000n);

    await expect(
      repository.load("00000000-0000-4000-8000-ffffffffffff", demoProjectRecord.project.id),
    ).resolves.toBeNull();
  });
});
