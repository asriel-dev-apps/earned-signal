import { StaffingProposalStaleError } from "@earned-signal/persistence";

export interface StaffingStorageFailure {
  readonly code: "PROJECT_REVISION_STALE" | "RESULT_PERSISTENCE_FAILED";
  readonly message: string;
}

export type StaffingStorageOutcome<T> =
  | { readonly kind: "STORED"; readonly value: T }
  | { readonly kind: "TERMINAL_FAILURE"; readonly failure: StaffingStorageFailure };

interface StaffingStoragePorts<T> {
  readonly store: () => Promise<T>;
  readonly recordFailure: (output: StaffingStorageFailure) => Promise<unknown>;
}

function storageFailure(error: unknown): StaffingStorageFailure {
  if (error instanceof StaffingProposalStaleError) {
    return {
      code: "PROJECT_REVISION_STALE",
      message: "Staffing Proposal became stale before its result was saved",
    };
  }
  return {
    code: "RESULT_PERSISTENCE_FAILED",
    message: "Staffing Proposal result could not be saved",
  };
}

/**
 * Converts an exhausted result-storage step into an idempotent terminal Run.
 * Workflow retries stay outside this function, in the injected `store` port.
 */
export async function storeStaffingResultOrFail<T>(
  ports: StaffingStoragePorts<T>,
): Promise<StaffingStorageOutcome<T>> {
  try {
    return { kind: "STORED", value: await ports.store() };
  } catch (error) {
    const failure = storageFailure(error);
    await ports.recordFailure(failure);
    return { kind: "TERMINAL_FAILURE", failure };
  }
}
