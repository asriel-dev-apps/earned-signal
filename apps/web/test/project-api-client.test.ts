import { describe, expect, it, vi } from "vitest";
import { createProjectApiClient, ProjectApiError } from "../src/project-api-client.js";
import { ScenarioPlanCommandSchema } from "../src/project-command-contract.js";
import { ScenarioPlanCommandResponseSchema } from "../src/scenario-response-contract.js";

describe("ProjectApiClient", () => {
  it("rejects progress or actual fields instead of stripping them from Scenario changes", () => {
    expect(ScenarioPlanCommandSchema.safeParse({
      type: "task.update",
      taskId: "00000000-0000-4000-8000-000000000001",
      changes: { durationWorkingDays: 5, progressBasisPoints: 5_000 },
    }).success).toBe(false);
    expect(ScenarioPlanCommandResponseSchema.safeParse({
      type: "task.update",
      taskId: "00000000-0000-4000-8000-000000000001",
      changes: {},
    }).success).toBe(false);
    expect(ScenarioPlanCommandResponseSchema.safeParse({
      type: "task.add",
      task: {
        id: "00000000-0000-4000-8000-000000000001",
        wbs: "1",
        wbsParentId: null,
        name: "Injected actuals",
        owner: "",
        durationWorkingDays: 1,
        measurementMethod: "PHYSICAL_PERCENT",
        calendarId: "standard",
        dependencies: [],
        constraint: null,
        requiredSkillIds: [],
        budget: 0,
        progressPercent: 1,
        actualCost: 0,
        actualMinutes: 0,
      },
    }).success).toBe(false);
  });
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

  it("serializes Scenario changes and revisioned human publication", async () => {
    const responses = [
      { id: "00000000-0000-4000-8000-000000000010", revision: "2", changes: [] },
      { revision: "8", replayed: false },
    ];
    const request = vi.fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createProjectApiClient({ tenantId: "tenant", projectId: "project", accessToken: () => "token" }, request);

    await expect(client.updateScenario("00000000-0000-4000-8000-000000000010", "1", [{
      type: "task.update",
      taskId: "00000000-0000-4000-8000-000000000001",
      changes: { durationWorkingDays: 8, budget: 750_000 },
    }])).rejects.toThrow();
    await client.publishScenario("00000000-0000-4000-8000-000000000010", "7", "2");

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      expectedRevision: "1",
      changes: [{
        type: "task.update",
        taskId: "00000000-0000-4000-8000-000000000001",
        changes: { durationWorkingDays: 8, budgetMinor: "750000" },
      }],
    });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      expectedProjectRevision: "7",
      expectedScenarioRevision: "2",
    });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ "idempotency-key": expect.any(String) });
  });

  it("reuses a Scenario publish idempotency key after an ambiguous transport failure", async () => {
    const request = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection closed after commit"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: "8", replayed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const client = createProjectApiClient({ tenantId: "tenant", projectId: "project", accessToken: () => "token" }, request);

    await expect(client.publishScenario("scenario", "7", "2")).rejects.toThrow("connection closed after commit");
    await expect(client.publishScenario("scenario", "7", "2")).resolves.toEqual({ revision: "8", replayed: true });

    const firstKey = (request.mock.calls[0]?.[1]?.headers as Record<string, string>)["idempotency-key"];
    const secondKey = (request.mock.calls[1]?.[1]?.headers as Record<string, string>)["idempotency-key"];
    expect(secondKey).toBe(firstKey);
  });
});
