import { createProjectCommandService } from "@earned-signal/application";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
} from "@earned-signal/persistence";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "../src/api.js";
import worker from "../src/worker.js";

describe("project command REST API", () => {
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

  beforeEach(async () => {
    await client.query("truncate table tenants cascade");
    await repository.save(demoProjectRecord);
  });

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  function createTestApp() {
    return createApiApp({
      resolveActor: async () => ({ type: "HUMAN", id: "user-001" }),
      openCommandSession: async () => ({
        service: createProjectCommandService(
          new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
        ),
        close: async () => undefined,
      }),
    });
  }

  it("executes and documents a typed project command", async () => {
    const app = createTestApp();
    const task = demoProjectRecord.activities[2]!;
    const response = await app.request(
      `/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "rest-progress-A3",
        },
        body: JSON.stringify({
          expectedRevision: "1",
          command: {
            type: "task.update",
            taskId: task.id,
            changes: { progressBasisPoints: 7_500, actualMinutes: 4_200 },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projectId: demoProjectRecord.project.id,
      revision: "2",
      replayed: false,
    });
    expect(response.headers.get("etag")).toBe('"2"');

    const specificationResponse = await app.request("/api/openapi.json");
    expect(specificationResponse.status).toBe(200);
    const specification = await specificationResponse.json<{
      paths: Record<string, unknown>;
    }>();
    expect(specification.paths).toHaveProperty(
      "/api/tenants/{tenantId}/projects/{projectId}/commands",
    );
  });

  it("returns the documented validation error for a malformed request", async () => {
    const app = createTestApp();
    const response = await app.request(
      `/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: "not-a-revision", command: {} }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "REQUEST_INVALID", message: "Request validation failed" },
    });
  });

  it("returns a replayed result for the same idempotent HTTP command", async () => {
    const app = createTestApp();
    const task = demoProjectRecord.activities[2]!;
    const url = `/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`;
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "http-replay-A3",
      },
      body: JSON.stringify({
        expectedRevision: "1",
        command: {
          type: "task.update",
          taskId: task.id,
          changes: { progressBasisPoints: 7_500 },
        },
      }),
    };

    await app.request(url, request);
    const replay = await app.request(url, request);

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ revision: "2", replayed: true });
  });

  it("returns current revision details for an optimistic conflict", async () => {
    const app = createTestApp();
    const task = demoProjectRecord.activities[2]!;
    const url = `/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`;
    const command = {
      expectedRevision: "1",
      command: {
        type: "task.update",
        taskId: task.id,
        changes: { progressBasisPoints: 7_500 },
      },
    };
    await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "first" },
      body: JSON.stringify(command),
    });

    const conflict = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "stale" },
      body: JSON.stringify(command),
    });

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "VERSION_CONFLICT",
        message: "Project revision conflict: expected 1, actual 2",
        expectedRevision: "1",
        actualRevision: "2",
      },
    });
  });

  it("keeps the deployed command route closed until an authentication adapter is installed", async () => {
    const response = await worker.request(
      `/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "unauthenticated",
        },
        body: JSON.stringify({
          expectedRevision: "1",
          command: {
            type: "task.delete",
            taskId: demoProjectRecord.activities[8]!.id,
          },
        }),
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required" },
    });
  });

  it("rejects a command body larger than 64 KiB before JSON buffering", async () => {
    const app = createTestApp();
    const response = await app.request(
      `/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "oversized",
        },
        body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
      },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "BODY_TOO_LARGE", message: "Request body exceeds 64 KiB" },
    });
  });
});
