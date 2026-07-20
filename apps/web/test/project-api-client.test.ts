import { describe, expect, it, vi } from "vitest";
import { createProjectApiClient, ProjectApiError } from "../src/project-api-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ProjectApiClient", () => {
  it("loads the persisted workspace with a bearer token", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ revision: "4", current: { tasks: [] } }),
    );
    const client = createProjectApiClient(
      { tenantId: "tenant", projectId: "project", accessToken: () => "signed-token" },
      request,
    );
    await expect(client.load()).resolves.toMatchObject({ revision: "4" });
    expect(request).toHaveBeenCalledWith("/api/tenants/tenant/projects/project", {
      headers: { authorization: "Bearer signed-token" },
    });
  });

  it("fetches the effort WBS grid projection", async () => {
    const projection = { projectId: "project", statusDate: "2026-06-01", rows: [], rollup: { bac: 0 } };
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(projection));
    const client = createProjectApiClient(
      { tenantId: "tenant", projectId: "project", accessToken: () => "token" },
      request,
    );
    await expect(client.grid()).resolves.toEqual(projection);
    expect(request).toHaveBeenCalledWith("/api/tenants/tenant/projects/project/wbs-grid", {
      headers: { authorization: "Bearer token" },
    });
  });

  it("serializes effort and progress edits in the REST contract", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ revision: "5", replayed: false }));
    const client = createProjectApiClient(
      { tenantId: "tenant", projectId: "project", accessToken: () => "token" },
      request,
    );
    await client.execute(
      {
        type: "task.update",
        taskId: "00000000-0000-4000-8000-000000000001",
        changes: { plannedEffortMinutes: 540, progressBasisPoints: 5_000 },
      },
      "4",
    );
    const init = request.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedRevision: "4",
      command: {
        type: "task.update",
        taskId: "00000000-0000-4000-8000-000000000001",
        changes: { plannedEffortMinutes: 540, progressBasisPoints: 5_000 },
      },
    });
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toEqual(expect.any(String));
  });

  it("exposes optimistic revision conflicts", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { code: "VERSION_CONFLICT", message: "Project changed", actualRevision: "8" } }, 409),
    );
    const client = createProjectApiClient(
      { tenantId: "tenant", projectId: "project", accessToken: () => "token" },
      request,
    );
    await expect(
      client.execute({ type: "task.delete", taskId: "00000000-0000-4000-8000-000000000001" }, "7"),
    ).rejects.toEqual(new ProjectApiError("VERSION_CONFLICT", "Project changed", "8"));
  });
});
