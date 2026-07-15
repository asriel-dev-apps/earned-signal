import {
  createProjectCommandAuthorizer,
  createProjectCommandService,
  type ProjectAccessGrant,
} from "@earned-signal/application";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectAccessRepository,
  ProjectRepository,
} from "@earned-signal/persistence";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "../src/api.js";

describe("project command REST API", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let accessRepository: ProjectAccessRepository;
  let repository: ProjectRepository;
  let stopContainer: (() => Promise<void>) | undefined;
  let workerProcess: ChildProcess | undefined;
  let workerOrigin: string;
  let jwksServer: HttpServer | undefined;
  let oidcIssuer: string;
  let humanAccessToken: string;
  let agentAccessToken: string;
  let humanMcpAccessToken: string;
  let agentMcpAccessToken: string;
  let multiAudienceAccessToken: string;
  const humanPrincipalId = "90000000-0000-4000-8000-000000000001";
  const agentPrincipalId = "90000000-0000-4000-8000-000000000002";

  async function reservePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("Could not reserve a Worker integration port"));
          return;
        }
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
  }

  async function waitForWorker(origin: string, process: ChildProcess): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (process.exitCode !== null) {
        throw new Error(`Wrangler exited before becoming ready with code ${process.exitCode}`);
      }
      try {
        const response = await fetch(`${origin}/api/health`);
        if (response.ok) return;
      } catch {
        // The local workerd socket is not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for the Worker integration server");
  }

  async function stopWorker(process: ChildProcess | undefined): Promise<void> {
    if (process === undefined || process.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        process.kill("SIGKILL");
      }, 5_000);
      process.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      process.kill("SIGTERM");
    });
  }

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    const database = createPersistenceDatabase(client);
    repository = new ProjectRepository(database);
    accessRepository = new ProjectAccessRepository(database);
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    jwksServer = createHttpServer((request, response) => {
      if (request.url !== "/jwks") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
      });
      response.end(
        JSON.stringify({ keys: [{ ...publicJwk, kid: "integration-key", alg: "RS256" }] }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      jwksServer?.once("error", reject);
      jwksServer?.listen(0, "127.0.0.1", resolve);
    });
    const jwksAddress = jwksServer.address();
    if (jwksAddress === null || typeof jwksAddress === "string") {
      throw new Error("Could not start the OIDC JWKS integration server");
    }
    oidcIssuer = `http://127.0.0.1:${jwksAddress.port}/`;
    const signAccessToken = (
      subject: string,
      audience: string | string[],
      scope?: string,
    ) => {
      const token = new SignJWT(scope === undefined ? {} : { scope })
        .setProtectedHeader({ alg: "RS256", kid: "integration-key", typ: "JWT" })
        .setIssuer(oidcIssuer)
        .setAudience(audience)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("1h");
      return token.sign(privateKey);
    };
    humanAccessToken = await signAccessToken("human-editor", "earned-signal-api");
    agentAccessToken = await signAccessToken(
      "progress-agent",
      "earned-signal-api",
      "project:progress:write project:actuals:write",
    );
    const port = await reservePort();
    workerOrigin = `http://127.0.0.1:${port}`;
    humanMcpAccessToken = await signAccessToken("human-editor", `${workerOrigin}/mcp`);
    agentMcpAccessToken = await signAccessToken(
      "progress-agent",
      `${workerOrigin}/mcp`,
      "project:progress:write project:actuals:write",
    );
    multiAudienceAccessToken = await signAccessToken("human-editor", [
      "earned-signal-api",
      `${workerOrigin}/mcp`,
    ]);
    workerProcess = spawn(
      "wrangler",
      [
        "dev",
        "--config",
        "wrangler.integration.jsonc",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--show-interactive-dev-session=false",
        "--log-level",
        "error",
        "--var",
        `OIDC_ISSUER:${oidcIssuer}`,
        "--var",
        "OIDC_AUDIENCE:earned-signal-api",
        "--var",
        `OIDC_JWKS_URL:${oidcIssuer}jwks`,
        "--var",
        `MCP_RESOURCE_URL:${workerOrigin}/mcp`,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
            started.getConnectionUri(),
          HOME: "/private/tmp/earned-signal-worker-home",
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: "/private/tmp/earned-signal-wrangler-integration.log",
        },
        stdio: "pipe",
      },
    );
    await waitForWorker(workerOrigin, workerProcess);
  }, 60_000);

  beforeEach(async () => {
    await client.query("truncate table principals, tenants cascade");
    await repository.save(demoProjectRecord);
    await accessRepository.provision({
      principal: {
        id: humanPrincipalId,
        issuer: oidcIssuer,
        subject: "human-editor",
        type: "HUMAN",
        displayName: "Integration human editor",
        allowedScopes: [],
      },
      tenantId: demoProjectRecord.tenant.id,
      tenantRole: "MEMBER",
      projectId: demoProjectRecord.project.id,
      projectRole: "EDITOR",
    });
    await accessRepository.provision({
      principal: {
        id: agentPrincipalId,
        issuer: oidcIssuer,
        subject: "progress-agent",
        type: "AGENT",
        displayName: "Integration progress agent",
        allowedScopes: ["project:progress:write", "project:actuals:write"],
      },
      tenantId: demoProjectRecord.tenant.id,
      tenantRole: "MEMBER",
      projectId: demoProjectRecord.project.id,
      projectRole: "EDITOR",
    });
  });

  afterAll(async () => {
    await stopWorker(workerProcess);
    await new Promise<void>((resolve, reject) => {
      if (jwksServer === undefined) {
        resolve();
        return;
      }
      jwksServer.close((error) => (error ? reject(error) : resolve()));
    });
    await client.end();
    await stopContainer?.();
  });

  function createTestApp(grant: ProjectAccessGrant | null = {
    principalId: "user-001",
    principalType: "HUMAN",
    projectRole: "EDITOR",
    allowedScopes: [],
  }) {
    return createApiApp({
      authenticate: async () => ({
        issuer: "https://identity.example.test/",
        subject: "test-principal",
        scopes: [],
      }),
      openCommandSession: async () => ({
        service: createProjectCommandService(
          new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
        ),
        authorizer: createProjectCommandAuthorizer({ resolve: async () => grant }),
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
      components?: { securitySchemes?: Record<string, unknown> };
    }>();
    expect(specification.paths).toHaveProperty(
      "/api/tenants/{tenantId}/projects/{projectId}/commands",
    );
    expect(specification.components?.securitySchemes).toHaveProperty("OidcBearer");
  });

  it("executes an authenticated command through workerd and Hyperdrive", async () => {
    const task = demoProjectRecord.activities[2]!;
    const response = await fetch(
      `${workerOrigin}/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "worker-hyperdrive-A3",
          authorization: `Bearer ${humanAccessToken}`,
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
    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.project.revision).toBe(2n);
    expect(stored?.auditEvents.at(-1)).toMatchObject({
      actorType: "HUMAN",
      actorId: humanPrincipalId,
      commandType: "task.update",
      projectRevision: 2n,
    });
  });

  it("replaces task assignments through the authenticated REST contract", async () => {
    const taskId = demoProjectRecord.activities[0]!.id;
    const assignments = [
      { resourceId: demoProjectRecord.resources[0]!.id, unitsPercent: 50 },
      { resourceId: demoProjectRecord.resources[1]!.id, unitsPercent: 25 },
    ];
    const response = await fetch(
      `${workerOrigin}/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "worker-replace-assignments",
          authorization: `Bearer ${humanAccessToken}`,
        },
        body: JSON.stringify({
          expectedRevision: "1",
          command: { type: "assignment.replace", taskId, assignments },
        }),
      },
    );

    expect(response.status).toBe(200);
    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(
      stored?.assignments
        .filter((assignment) => assignment.activityId === taskId)
        .map(({ resourceId, unitsPercent }) => ({ resourceId, unitsPercent })),
    ).toEqual(assignments);
    expect(stored?.auditEvents.at(-1)).toMatchObject({
      actorType: "HUMAN",
      actorId: humanPrincipalId,
      commandType: "assignment.replace",
      projectRevision: 2n,
    });
  });

  it("executes a scoped agent progress command and audits the service principal", async () => {
    const task = demoProjectRecord.activities[2]!;
    const response = await fetch(
      `${workerOrigin}/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "worker-agent-progress-A3",
          authorization: `Bearer ${agentAccessToken}`,
        },
        body: JSON.stringify({
          expectedRevision: "1",
          command: {
            type: "task.update",
            taskId: task.id,
            changes: { progressBasisPoints: 7_500 },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.auditEvents.at(-1)).toMatchObject({
      actorType: "AGENT",
      actorId: agentPrincipalId,
      commandType: "task.update",
      projectRevision: 2n,
    });
  });

  it("requires human approval for an authenticated agent plan change", async () => {
    const response = await fetch(
      `${workerOrigin}/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "worker-agent-plan-A3",
          authorization: `Bearer ${agentAccessToken}`,
        },
        body: JSON.stringify({
          expectedRevision: "1",
          command: {
            type: "task.update",
            taskId: demoProjectRecord.activities[2]!.id,
            changes: { durationWorkingDays: 10 },
          },
        }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AGENT_APPROVAL_REQUIRED",
        message: "Agent plan changes require human approval",
      },
    });
    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.project.revision).toBe(1n);
    expect(stored?.auditEvents).toHaveLength(1);
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

  it("rejects a workerd command without a bearer access token", async () => {
    const response = await fetch(
      `${workerOrigin}/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
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
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({
      error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required" },
    });
  });

  it("advertises OAuth protected-resource metadata for unauthenticated MCP clients", async () => {
    const resource = `${workerOrigin}/mcp`;
    const metadataUrl = `${workerOrigin}/.well-known/oauth-protected-resource/mcp`;
    const response = await fetch(resource, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "earned-signal-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${metadataUrl}"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");

    const metadata = await fetch(metadataUrl);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toEqual({
      resource,
      authorization_servers: [oidcIssuer],
      scopes_supported: ["project:progress:write", "project:actuals:write"],
      bearer_methods_supported: ["header"],
      resource_name: "EarnedSignal project commands",
    });
  });

  it("rejects a valid API token whose audience is not the MCP resource", async () => {
    const response = await fetch(`${workerOrigin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${humanAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "earned-signal-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("rejects a token shared by the REST and MCP audiences at both boundaries", async () => {
    const rest = await fetch(
      `${workerOrigin}/api/tenants/${demoProjectRecord.tenant.id}/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${multiAudienceAccessToken}`,
          "content-type": "application/json",
          "idempotency-key": "multi-audience-rest",
        },
        body: JSON.stringify({
          expectedRevision: "1",
          command: {
            type: "task.update",
            taskId: demoProjectRecord.activities[2]!.id,
            changes: { progressBasisPoints: 7_500 },
          },
        }),
      },
    );
    const mcp = await fetch(`${workerOrigin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${multiAudienceAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "earned-signal-test", version: "1.0.0" },
        },
      }),
    });

    expect(rest.status).toBe(401);
    expect(mcp.status).toBe(401);
    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.project.revision).toBe(1n);
    expect(stored?.auditEvents).toHaveLength(1);
  });

  it("rejects a cross-origin MCP request before protocol handling", async () => {
    const response = await fetch(`${workerOrigin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${humanMcpAccessToken}`,
        "content-type": "application/json",
        origin: "https://attacker.example.test",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "earned-signal-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects an MCP request body larger than 64 KiB", async () => {
    const response = await fetch(`${workerOrigin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${humanMcpAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("initializes an authenticated MCP client and lists focused project tools", async () => {
    const mcp = new McpClient({ name: "earned-signal-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${workerOrigin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${humanMcpAccessToken}` } },
    });

    try {
      // SDK 1.29's concrete class exposes `sessionId: string | undefined`, while its
      // Transport interface declares the same runtime contract as an optional property.
      await mcp.connect(transport as Transport);
      const tools = await mcp.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "update_project_task",
        "add_project_task",
        "delete_project_task",
        "add_project_resource",
        "update_project_resource",
        "delete_project_resource",
        "replace_task_assignments",
      ]);
      expect(tools.tools.map((tool) => tool.annotations)).toEqual([
        {
          title: "Update project task",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        {
          title: "Add project task",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        {
          title: "Delete project task",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        {
          title: "Add project resource",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        {
          title: "Update project resource",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        {
          title: "Delete project resource",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        {
          title: "Replace task assignments",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      ]);
    } finally {
      await mcp.close();
    }
  });

  it("executes and idempotently replays an audited agent progress tool through workerd", async () => {
    const mcp = new McpClient({ name: "earned-signal-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${workerOrigin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${agentMcpAccessToken}` } },
    });
    const task = demoProjectRecord.activities[2]!;
    const request = {
      name: "update_project_task",
      arguments: {
        tenantId: demoProjectRecord.tenant.id,
        projectId: demoProjectRecord.project.id,
        expectedRevision: "1",
        idempotencyKey: "mcp-agent-progress-A3",
        taskId: task.id,
        changes: { progressBasisPoints: 7_500, actualMinutes: 4_200 },
      },
    };

    try {
      await mcp.connect(transport as Transport);
      const result = await mcp.callTool(request);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        projectId: demoProjectRecord.project.id,
        revision: "2",
        replayed: false,
      });

      const replay = await mcp.callTool(request);
      expect(replay.structuredContent).toEqual({
        projectId: demoProjectRecord.project.id,
        revision: "2",
        replayed: true,
      });
    } finally {
      await mcp.close();
    }

    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.project.revision).toBe(2n);
    expect(stored?.auditEvents.at(-1)).toMatchObject({
      actorType: "AGENT",
      actorId: agentPrincipalId,
      commandType: "task.update",
      projectRevision: 2n,
    });
  });

  it("adds and deletes a task through authenticated human MCP tools", async () => {
    const mcp = new McpClient({ name: "earned-signal-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${workerOrigin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${humanMcpAccessToken}` } },
    });
    const taskId = "30000000-0000-4000-8000-000000000099";
    const commandContext = {
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
    };

    try {
      await mcp.connect(transport as Transport);
      const added = await mcp.callTool({
        name: "add_project_task",
        arguments: {
          ...commandContext,
          expectedRevision: "1",
          idempotencyKey: "mcp-human-add-task",
          task: {
            id: taskId,
            wbs: "1.10",
            wbsParentId: demoProjectRecord.wbsNodes[0]!.id,
            name: "Publish readiness review",
            owner: "Delivery lead",
            durationWorkingDays: 2,
            measurementMethod: "ZERO_HUNDRED",
            calendarId: demoProjectRecord.project.defaultCalendarId,
            dependencies: [],
            constraint: null,
            requiredSkillIds: [],
            budgetMinor: "80000",
            progressBasisPoints: 0,
            actualCostMinor: "0",
            actualMinutes: 0,
          },
        },
      });
      expect(added.structuredContent).toMatchObject({ revision: "2", replayed: false });

      const deleted = await mcp.callTool({
        name: "delete_project_task",
        arguments: {
          ...commandContext,
          expectedRevision: "2",
          idempotencyKey: "mcp-human-delete-task",
          taskId,
        },
      });
      expect(deleted.structuredContent).toMatchObject({ revision: "3", replayed: false });
    } finally {
      await mcp.close();
    }

    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.activities.some((activity) => activity.id === taskId)).toBe(false);
    expect(stored?.auditEvents.slice(-2).map((event) => event.commandType)).toEqual([
      "task.add",
      "task.delete",
    ]);
  });

  it("replaces and audits task assignments through the human MCP tool", async () => {
    const mcp = new McpClient({ name: "earned-signal-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${workerOrigin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${humanMcpAccessToken}` } },
    });
    const taskId = demoProjectRecord.activities[0]!.id;
    const assignments = [
      { resourceId: demoProjectRecord.resources[0]!.id, unitsPercent: 50 },
      { resourceId: demoProjectRecord.resources[1]!.id, unitsPercent: 25 },
    ];

    try {
      await mcp.connect(transport as Transport);
      const result = await mcp.callTool({
        name: "replace_task_assignments",
        arguments: {
          tenantId: demoProjectRecord.tenant.id,
          projectId: demoProjectRecord.project.id,
          expectedRevision: "1",
          idempotencyKey: "mcp-human-replace-assignments",
          taskId,
          assignments,
        },
      });
      expect(result.structuredContent).toMatchObject({ revision: "2", replayed: false });
    } finally {
      await mcp.close();
    }

    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(
      stored?.assignments
        .filter((assignment) => assignment.activityId === taskId)
        .map(({ resourceId, unitsPercent }) => ({ resourceId, unitsPercent })),
    ).toEqual(assignments);
    expect(stored?.auditEvents.at(-1)).toMatchObject({
      actorType: "HUMAN",
      commandType: "assignment.replace",
    });
  });

  it("returns an approval error instead of applying an agent plan tool", async () => {
    const mcp = new McpClient({ name: "earned-signal-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${workerOrigin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${agentMcpAccessToken}` } },
    });

    try {
      await mcp.connect(transport as Transport);
      const result = await mcp.callTool({
        name: "update_project_task",
        arguments: {
          tenantId: demoProjectRecord.tenant.id,
          projectId: demoProjectRecord.project.id,
          expectedRevision: "1",
          idempotencyKey: "mcp-agent-plan-A3",
          taskId: demoProjectRecord.activities[2]!.id,
          changes: { durationWorkingDays: 10 },
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "AGENT_APPROVAL_REQUIRED",
              message: "Agent plan changes require human approval",
            },
          }),
        },
      ]);
    } finally {
      await mcp.close();
    }

    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.project.revision).toBe(1n);
    expect(stored?.auditEvents).toHaveLength(1);
  });

  it("rejects an authenticated cross-tenant MCP tool without mutation", async () => {
    const mcp = new McpClient({ name: "earned-signal-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${workerOrigin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${humanMcpAccessToken}` } },
    });

    try {
      await mcp.connect(transport as Transport);
      const result = await mcp.callTool({
        name: "delete_project_task",
        arguments: {
          tenantId: "00000000-0000-4000-8000-000000000099",
          projectId: demoProjectRecord.project.id,
          expectedRevision: "1",
          idempotencyKey: "mcp-cross-tenant",
          taskId: demoProjectRecord.activities[8]!.id,
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "PROJECT_ACCESS_DENIED",
              message: "Project command is not permitted",
            },
          }),
        },
      ]);
    } finally {
      await mcp.close();
    }

    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.project.revision).toBe(1n);
    expect(stored?.auditEvents).toHaveLength(1);
  });

  it("returns stable validation errors for unsafe update and add money values", async () => {
    const mcp = new McpClient({ name: "earned-signal-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${workerOrigin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${humanMcpAccessToken}` } },
    });
    const expectedError = [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "COMMAND_INVALID",
            message: "actualCostMinor exceeds the supported API range",
          },
        }),
      },
    ];

    try {
      await mcp.connect(transport as Transport);
      const update = await mcp.callTool({
        name: "update_project_task",
        arguments: {
          tenantId: demoProjectRecord.tenant.id,
          projectId: demoProjectRecord.project.id,
          expectedRevision: "1",
          idempotencyKey: "mcp-unsafe-update-money",
          taskId: demoProjectRecord.activities[2]!.id,
          changes: { actualCostMinor: "9007199254740992" },
        },
      });
      expect(update.isError).toBe(true);
      expect(update.content).toEqual(expectedError);

      const add = await mcp.callTool({
        name: "add_project_task",
        arguments: {
          tenantId: demoProjectRecord.tenant.id,
          projectId: demoProjectRecord.project.id,
          expectedRevision: "1",
          idempotencyKey: "mcp-unsafe-add-money",
          task: {
            id: "30000000-0000-4000-8000-000000000098",
            wbs: "1.10",
            wbsParentId: demoProjectRecord.wbsNodes[0]!.id,
            name: "Unsafe budget",
            owner: "Delivery lead",
            durationWorkingDays: 2,
            measurementMethod: "ZERO_HUNDRED",
            calendarId: demoProjectRecord.project.defaultCalendarId,
            dependencies: [],
            constraint: null,
            requiredSkillIds: [],
            budgetMinor: "9007199254740992",
            progressBasisPoints: 0,
            actualCostMinor: "0",
            actualMinutes: 0,
          },
        },
      });
      expect(add.isError).toBe(true);
      expect(add.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "COMMAND_INVALID",
              message: "budgetMinor exceeds the supported API range",
            },
          }),
        },
      ]);
    } finally {
      await mcp.close();
    }

    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.project.revision).toBe(1n);
    expect(stored?.auditEvents).toHaveLength(1);
  });

  it("rejects an authenticated cross-tenant project path before mutation", async () => {
    const response = await fetch(
      `${workerOrigin}/api/tenants/00000000-0000-4000-8000-000000000099/projects/${demoProjectRecord.project.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "cross-tenant",
          authorization: `Bearer ${humanAccessToken}`,
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

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PROJECT_ACCESS_DENIED",
        message: "Project command is not permitted",
      },
    });
    const stored = await repository.load(
      demoProjectRecord.tenant.id,
      demoProjectRecord.project.id,
    );
    expect(stored?.project.revision).toBe(1n);
    expect(stored?.auditEvents).toHaveLength(1);
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
