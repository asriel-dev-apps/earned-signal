import {
  projectWbsGrid,
  ProjectAccessDeniedError,
  ProjectCommandValidationError,
  ProjectVersionConflictError,
  type AuditActor,
  type ProjectAccessGrant,
  type ProjectCommandExecution,
  type ProjectRole,
  type ProjectState,
} from "@vecta/application";
import { describe, expect, it, vi } from "vitest";
import { createApiApp, type ProjectSession } from "../src/api.js";
import { createDemoProject } from "../src/demo-project.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "b0000000-0000-4000-8000-000000000001";
const BASE = `/api/tenants/${TENANT_ID}/projects/${PROJECT_ID}`;

const IDENTITY = { issuer: "https://identity.test/", subject: "editor", scopes: [] as string[] };
const env = {} as Env;

function grant(projectRole: ProjectRole = "EDITOR"): ProjectAccessGrant {
  return {
    principalId: "principal-1",
    principalType: "HUMAN",
    projectRole,
    allowedScopes: [],
  };
}

interface SessionOverrides {
  readonly project?: ProjectState | null;
  readonly projectRole?: ProjectRole;
  readonly authorize?: () => Promise<AuditActor>;
  readonly execute?: () => Promise<ProjectCommandExecution>;
}

function fakeApp(overrides: SessionOverrides = {}) {
  const project = overrides.project === undefined ? createDemoProject({ parentCount: 2, subtasksPerParent: 2, memberCount: 2 }) : overrides.project;
  const session: ProjectSession = {
    service: {
      execute:
        overrides.execute ??
        (async () => ({ projectId: PROJECT_ID, revision: 8n, replayed: false })),
    },
    authorizer: {
      authorize: overrides.authorize ?? (async () => ({ type: "HUMAN", id: "actor-1" })),
    },
    queryAuthorizer: {
      authorize: async () => grant(overrides.projectRole ?? "EDITOR"),
    },
    workspace: {
      load: async () => (project === null ? null : { revision: 7n, current: project }),
    },
    close: async () => undefined,
  };
  const authenticate = vi.fn(async () => IDENTITY);
  const openProjectSession = vi.fn(async () => session);
  const app = createApiApp({ authenticate, openProjectSession });
  return { app, authenticate, openProjectSession, session, project };
}

describe("project REST API", () => {
  it("serves a health probe", async () => {
    const { app } = fakeApp();
    const response = await app.request("/api/health", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: "vecta", status: "ok" });
  });

  it("loads the persisted Current workspace as stored inputs", async () => {
    const { app, project } = fakeApp();
    const response = await app.request(BASE, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { revision: string; current: ProjectState };
    expect(body.revision).toBe("7");
    expect(body.current.tasks).toHaveLength(project!.tasks.length);
    // Stored inputs only — no derived money/EVM columns leak into the workspace.
    expect(Object.keys(body.current.tasks[0]!)).not.toContain("plannedEffortHours");
  });

  it("returns 404 when the project is absent", async () => {
    const { app } = fakeApp({ project: null });
    const response = await app.request(BASE, {}, env);
    expect(response.status).toBe(404);
  });

  it("projects the effort WBS grid with derived columns and the rollup", async () => {
    const { app, project } = fakeApp();
    const response = await app.request(`${BASE}/wbs-grid`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { rows: unknown[]; rollup: Record<string, unknown> };
    const expected = projectWbsGrid(project!);
    expect(body).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(body.rows[0]).toHaveProperty("plannedEffortHours");
    expect(body.rollup).toHaveProperty("spi");
  });

  it("serves the WBS grid to the GENERAL (VIEWER) role without a member-sensitive column", async () => {
    const { app, project } = fakeApp({ projectRole: "VIEWER" });
    const response = await app.request(`${BASE}/wbs-grid`, {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Record<string, unknown>[] };
    expect(body.rows).toHaveLength(project!.tasks.length);
    for (const row of body.rows) {
      expect(row).not.toHaveProperty("dailyCapacityMinutes");
    }
  });

  it("omits member capacity from the workspace load for the GENERAL (VIEWER) role", async () => {
    const { app } = fakeApp({ projectRole: "VIEWER" });
    const response = await app.request(BASE, {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      current: { members: Record<string, unknown>[] };
    };
    expect(body.current.members.length).toBeGreaterThan(0);
    for (const member of body.current.members) {
      // Basis 6: the sensitive key is absent from the API response itself, not
      // hidden client-side.
      expect("dailyCapacityMinutes" in member).toBe(false);
    }
  });

  it("keeps member capacity in the workspace load for a PRIVILEGED role", async () => {
    for (const projectRole of ["OWNER", "EDITOR"] as const) {
      const { app } = fakeApp({ projectRole });
      const response = await app.request(BASE, {}, env);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        current: { members: Record<string, unknown>[] };
      };
      expect(body.current.members.length).toBeGreaterThan(0);
      for (const member of body.current.members) {
        expect("dailyCapacityMinutes" in member).toBe(true);
        expect(typeof member.dailyCapacityMinutes).toBe("number");
      }
    }
  });

  it("executes a revisioned task.update command", async () => {
    const execute = vi.fn(async () => ({ projectId: PROJECT_ID, revision: 8n, replayed: false }));
    const { app } = fakeApp({ execute });
    const response = await app.request(
      `${BASE}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({
          expectedRevision: "7",
          command: { type: "task.update", taskId: PROJECT_ID, changes: { progressBasisPoints: 5_000 } },
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"8"');
    await expect(response.json()).resolves.toEqual({ projectId: PROJECT_ID, revision: "8", replayed: false });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("executes a task.generateSubtasks command", async () => {
    const execute = vi.fn(async () => ({ projectId: PROJECT_ID, revision: 8n, replayed: false }));
    const { app } = fakeApp({ execute });
    const response = await app.request(
      `${BASE}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-gen" },
        body: JSON.stringify({
          expectedRevision: "7",
          command: { type: "task.generateSubtasks", parentTaskId: PROJECT_ID, templateId: TENANT_ID },
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects a malformed command with 400", async () => {
    const { app } = fakeApp();
    const response = await app.request(
      `${BASE}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({ expectedRevision: "7", command: { type: "task.update" } }),
      },
      env,
    );
    expect(response.status).toBe(400);
  });

  it("maps an authorization failure to 403", async () => {
    const { app } = fakeApp({
      authorize: async () => { throw new ProjectAccessDeniedError(); },
    });
    const response = await app.request(
      `${BASE}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({
          expectedRevision: "7",
          command: { type: "task.delete", taskId: PROJECT_ID },
        }),
      },
      env,
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_ACCESS_DENIED");
  });

  it("maps an optimistic revision conflict to 409 with revisions", async () => {
    const { app } = fakeApp({
      execute: async () => { throw new ProjectVersionConflictError(7n, 9n); },
    });
    const response = await app.request(
      `${BASE}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({
          expectedRevision: "7",
          command: { type: "task.delete", taskId: PROJECT_ID },
        }),
      },
      env,
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; actualRevision?: string } };
    expect(body.error.code).toBe("VERSION_CONFLICT");
    expect(body.error.actualRevision).toBe("9");
  });

  it("maps a domain validation failure to 422", async () => {
    const { app } = fakeApp({
      execute: async () => { throw new ProjectCommandValidationError("bad"); },
    });
    const response = await app.request(
      `${BASE}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({
          expectedRevision: "7",
          command: { type: "task.delete", taskId: PROJECT_ID },
        }),
      },
      env,
    );
    expect(response.status).toBe(422);
  });
});
