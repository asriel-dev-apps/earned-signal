import { describe, expect, it, vi } from "vitest";
import { ensureStaffingWorkflow } from "../src/workflow-dispatch.js";

const payload = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000001",
  proposalId: "20000000-0000-4000-8000-000000000001",
};

describe("ensureStaffingWorkflow", () => {
  it("creates a missing workflow with the proposal ID", async () => {
    const get = vi.fn(async () => ({ status: async () => ({ status: "unknown" }) }));
    const create = vi.fn(async () => ({ status: async () => ({ status: "queued" }) }));

    await ensureStaffingWorkflow({ get, create }, payload);

    expect(create).toHaveBeenCalledWith({ id: payload.proposalId, params: payload });
  });

  it("treats an existing or concurrently-created instance as a successful replay", async () => {
    const existingCreate = vi.fn();
    await ensureStaffingWorkflow({
      get: async () => ({ status: async () => ({ status: "running" }) }),
      create: existingCreate,
    }, payload);
    expect(existingCreate).not.toHaveBeenCalled();

    let reads = 0;
    await ensureStaffingWorkflow({
      get: async () => ({ status: async () => ({ status: ++reads === 1 ? "unknown" : "queued" }) }),
      create: async () => { throw new Error("instance already exists"); },
    }, payload);
  });

  it("preserves a dispatch failure when no workflow instance exists", async () => {
    await expect(ensureStaffingWorkflow({
      get: async () => ({ status: async () => ({ status: "unknown" }) }),
      create: async () => { throw new Error("dispatch unavailable"); },
    }, payload)).rejects.toThrow("dispatch unavailable");
  });
});
