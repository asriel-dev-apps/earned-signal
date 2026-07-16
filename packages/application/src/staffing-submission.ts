import type { AuthenticatedIdentity, StaffingProposalAuthorizer } from "./project-command-authorizer.js";
import {
  ProjectCommandValidationError,
  ProjectNotFoundError,
  type AuditActor,
} from "./project-command-service.js";
import type { ProjectResource, ProjectState } from "./project-state.js";
import {
  validateStaffingProposalRequest,
  type ConfirmedRemainingEffort,
  type StaffingConstraintsV1,
  type StaffingObjectiveV1,
  type StaffingProposalRequest,
} from "./staffing.js";

export interface StaffingProposalSubmissionRequest {
  readonly identity: AuthenticatedIdentity;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
  readonly remainingEffort: readonly ConfirmedRemainingEffort[];
  readonly candidateResources: readonly ProjectResource[];
  readonly constraints: StaffingConstraintsV1;
  readonly objective: StaffingObjectiveV1;
}

export interface StaffingProposalSubmissionRecord {
  readonly id: string;
  readonly status: "REQUESTED" | "RUNNING" | "READY" | "INFEASIBLE" | "UNKNOWN" | "FAILED";
}

export interface CreateStaffingProposalInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly baseProjectRevision: bigint;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly input: StaffingProposalRequest;
  readonly actor: AuditActor;
}

export interface StaffingProposalSubmissionPorts<TProposal extends StaffingProposalSubmissionRecord> {
  readonly authorizer: StaffingProposalAuthorizer;
  readonly workspace: {
    load(tenantId: string, projectId: string): Promise<{
      readonly current: ProjectState;
      readonly baseline: ProjectState | null;
    } | null>;
  };
  readonly proposals: {
    create(input: CreateStaffingProposalInput): Promise<{
      readonly proposal: TProposal;
      readonly replayed: boolean;
    }>;
  };
  readonly requestHasher: {
    hash(name: string, input: StaffingProposalRequest): Promise<string>;
  };
  readonly dispatch: (request: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly proposalId: string;
  }) => Promise<void>;
}

export interface StaffingProposalSubmissionService<TProposal extends StaffingProposalSubmissionRecord> {
  submit(request: StaffingProposalSubmissionRequest): Promise<{
    readonly proposal: TProposal;
    readonly replayed: boolean;
  }>;
}

export function createStaffingProposalSubmissionService<TProposal extends StaffingProposalSubmissionRecord>(
  ports: StaffingProposalSubmissionPorts<TProposal>,
): StaffingProposalSubmissionService<TProposal> {
  return {
    async submit(request) {
      const actor = await ports.authorizer.authorize({
        identity: request.identity,
        tenantId: request.tenantId,
        projectId: request.projectId,
      });
      const workspace = await ports.workspace.load(request.tenantId, request.projectId);
      if (workspace === null) throw new ProjectNotFoundError(request.projectId);
      if (workspace.baseline === null) {
        throw new ProjectCommandValidationError("Staffing Proposal requires an approved Baseline");
      }

      const input: StaffingProposalRequest = {
        currentRevision: request.expectedRevision,
        current: workspace.current,
        remainingEffort: request.remainingEffort,
        candidateResources: request.candidateResources,
        constraints: request.constraints,
        objective: request.objective,
      };
      try {
        validateStaffingProposalRequest(input);
      } catch (error) {
        throw new ProjectCommandValidationError(
          error instanceof Error ? error.message : "Staffing Proposal input is invalid",
        );
      }

      const name = request.name.trim();
      const result = await ports.proposals.create({
        tenantId: request.tenantId,
        projectId: request.projectId,
        name,
        baseProjectRevision: BigInt(request.expectedRevision),
        idempotencyKey: request.idempotencyKey,
        requestHash: await ports.requestHasher.hash(name, input),
        input,
        actor,
      });
      if (result.proposal.status === "REQUESTED") {
        await ports.dispatch({
          tenantId: request.tenantId,
          projectId: request.projectId,
          proposalId: result.proposal.id,
        });
      }
      return result;
    },
  };
}
