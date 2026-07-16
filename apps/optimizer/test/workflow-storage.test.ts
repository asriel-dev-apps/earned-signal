import { StaffingProposalStaleError } from "@earned-signal/persistence";
import { describe, expect, it, vi } from "vitest";
import { storeStaffingResultOrFail } from "../src/workflow-storage.js";

describe("storeStaffingResultOrFail", () => {
  it("terminalizes a result rejected by the Project revision guard", async () => {
    const recordFailure = vi.fn(async () => ({ accepted: true }));

    await expect(storeStaffingResultOrFail({
      store: async () => {
        throw new StaffingProposalStaleError(7n, 8n);
      },
      recordFailure,
    })).resolves.toEqual({
      kind: "TERMINAL_FAILURE",
      failure: {
        code: "PROJECT_REVISION_STALE",
        message: "Staffing Proposal became stale before its result was saved",
      },
    });
    expect(recordFailure).toHaveBeenCalledWith({
      code: "PROJECT_REVISION_STALE",
      message: "Staffing Proposal became stale before its result was saved",
    });
  });

  it("records a terminal failure after the storage port exhausts its retries", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error("first transient failure"))
      .mockRejectedValueOnce(new Error("second transient failure"))
      .mockRejectedValueOnce(new Error("database unavailable after retries"));
    const store = async (): Promise<never> => {
      let lastError: unknown;
      for (let index = 0; index < 3; index += 1) {
        try {
          return await attempt() as never;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };
    const recordFailure = vi.fn(async () => ({ accepted: true }));

    await expect(storeStaffingResultOrFail({ store, recordFailure })).resolves.toMatchObject({
      kind: "TERMINAL_FAILURE",
      failure: { code: "RESULT_PERSISTENCE_FAILED" },
    });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(recordFailure).toHaveBeenCalledTimes(1);
  });

  it("is safe when a replay observes the first terminal failure", async () => {
    let accepted = true;
    const recorded: boolean[] = [];
    const ports = {
      store: async (): Promise<never> => {
        throw new Error("result transaction failed");
      },
      recordFailure: async () => {
        recorded.push(accepted);
        accepted = false;
      },
    };

    await expect(storeStaffingResultOrFail(ports)).resolves.toMatchObject({ kind: "TERMINAL_FAILURE" });
    await expect(storeStaffingResultOrFail(ports)).resolves.toMatchObject({ kind: "TERMINAL_FAILURE" });
    expect(recorded).toEqual([true, false]);
  });

  it("returns a stored value without writing a failure Run", async () => {
    const recordFailure = vi.fn();

    await expect(storeStaffingResultOrFail({
      store: async () => ({ status: "READY" as const, scenarioId: "scenario-1" }),
      recordFailure,
    })).resolves.toEqual({
      kind: "STORED",
      value: { status: "READY", scenarioId: "scenario-1" },
    });
    expect(recordFailure).not.toHaveBeenCalled();
  });
});
