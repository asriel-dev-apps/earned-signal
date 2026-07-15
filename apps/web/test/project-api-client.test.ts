import { describe, expect, it, vi } from "vitest";
import { createProjectApiClient, ProjectApiError } from "../src/project-api-client.js";

describe("ProjectApiClient", () => {
  it("loads the persisted workspace with a bearer token", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ revision: "4", current: {}, baseline: null, baselineVersion: null }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createProjectApiClient({ tenantId: "tenant", projectId: "project", accessToken: () => "signed-token" }, request);
    await expect(client.load()).resolves.toMatchObject({ revision: "4" });
    expect(request).toHaveBeenCalledWith("/api/tenants/tenant/projects/project", { headers: { authorization: "Bearer signed-token" } });
  });

  it("sends revisioned commands and exposes optimistic conflicts", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "PROJECT_VERSION_CONFLICT", message: "Project changed", actualRevision: "8" } }), { status: 409, headers: { "content-type": "application/json" } }));
    const client = createProjectApiClient({ tenantId: "tenant", projectId: "project", accessToken: () => "token" }, request);
    await expect(client.execute({ type: "task.delete", taskId: "00000000-0000-4000-8000-000000000001" }, "7")).rejects.toEqual(new ProjectApiError("PROJECT_VERSION_CONFLICT", "Project changed", "8"));
  });

  it("serializes actual effort and cost edits in the REST contract", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ revision: "5", replayed: false }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createProjectApiClient({ tenantId: "tenant", projectId: "project", accessToken: () => "token" }, request);
    await client.execute({
      type: "task.update",
      taskId: "00000000-0000-4000-8000-000000000001",
      changes: { actualMinutes: 540, actualCost: 125_000 },
    }, "4");
    const init = request.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedRevision: "4",
      command: {
        type: "task.update",
        taskId: "00000000-0000-4000-8000-000000000001",
        changes: { actualMinutes: 540, actualCostMinor: "125000" },
      },
    });
  });
});
