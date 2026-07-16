export interface StaffingWorkflowPayload {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proposalId: string;
}

interface WorkflowInstanceHandle {
  status(): Promise<{ readonly status: string }>;
}

interface StaffingWorkflowBinding {
  get(id: string): Promise<WorkflowInstanceHandle>;
  create(options: { readonly id: string; readonly params: StaffingWorkflowPayload }): Promise<WorkflowInstanceHandle>;
}

async function hasInstance(binding: StaffingWorkflowBinding, id: string): Promise<boolean> {
  try {
    return (await (await binding.get(id)).status()).status !== "unknown";
  } catch {
    return false;
  }
}

export async function ensureStaffingWorkflow(
  binding: StaffingWorkflowBinding,
  payload: StaffingWorkflowPayload,
): Promise<void> {
  if (await hasInstance(binding, payload.proposalId)) return;
  try {
    await binding.create({ id: payload.proposalId, params: payload });
  } catch (error) {
    // A replay can race the original dispatch after the proposal commit. Treat
    // an observable instance as success; otherwise preserve the dispatch error.
    if (await hasInstance(binding, payload.proposalId)) return;
    throw error;
  }
}
