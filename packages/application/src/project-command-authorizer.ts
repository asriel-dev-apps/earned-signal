import type { AuditActor } from "./project-command-service.js";
import type { ProjectCommand } from "./project-state.js";

export interface AuthenticatedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: readonly string[];
}

export type ProjectRole = "OWNER" | "EDITOR" | "VIEWER";

export interface ProjectAccessGrant {
  readonly principalId: string;
  readonly principalType: "HUMAN" | "AGENT";
  readonly projectRole: ProjectRole;
  readonly allowedScopes: readonly string[];
}

export interface ProjectAccessGrantRequest {
  readonly identity: AuthenticatedIdentity;
  readonly tenantId: string;
  readonly projectId: string;
}

export interface ProjectAccessGrantResolver {
  resolve(request: ProjectAccessGrantRequest): Promise<ProjectAccessGrant | null>;
}

export interface ProjectCommandAuthorizationRequest extends ProjectAccessGrantRequest {
  readonly command: ProjectCommand;
}

export interface ProjectCommandAuthorizer {
  authorize(request: ProjectCommandAuthorizationRequest): Promise<AuditActor>;
}

export interface ProjectQueryAuthorizer {
  authorize(request: ProjectAccessGrantRequest): Promise<ProjectAccessGrant>;
}

export interface ScenarioMutationAuthorizer {
  authorize(request: ProjectAccessGrantRequest): Promise<AuditActor>;
}

export interface StaffingProposalAuthorizer {
  authorize(request: ProjectAccessGrantRequest): Promise<AuditActor>;
}

export class ProjectAccessDeniedError extends Error {
  constructor() {
    super("Project command is not permitted");
    this.name = "ProjectAccessDeniedError";
  }
}

export class AgentPlanApprovalRequiredError extends Error {
  constructor() {
    super("Agent plan changes require human approval");
    this.name = "AgentPlanApprovalRequiredError";
  }
}

function isAgentPlanChange(command: ProjectCommand): boolean {
  if (command.type !== "task.update") return true;
  const directAgentFields = new Set(["progressPercent", "actualMinutes", "actualCost"]);
  return Object.keys(command.changes).some((field) => !directAgentFields.has(field));
}

function canAgentApply(
  request: ProjectCommandAuthorizationRequest,
  grant: ProjectAccessGrant,
): boolean {
  if (request.command.type !== "task.update") return false;
  const changedFields = Object.keys(request.command.changes);
  if (changedFields.length === 0) {
    return false;
  }
  if (isAgentPlanChange(request.command)) return false;

  const requiredScopes = new Set<string>();
  if (changedFields.includes("progressPercent")) {
    requiredScopes.add("project:progress:write");
  }
  if (changedFields.includes("actualMinutes") || changedFields.includes("actualCost")) {
    requiredScopes.add("project:actuals:write");
  }
  return [...requiredScopes].every(
    (scope) =>
      grant.allowedScopes.includes(scope) && request.identity.scopes.includes(scope),
  );
}

export function createProjectCommandAuthorizer(
  resolver: ProjectAccessGrantResolver,
): ProjectCommandAuthorizer {
  return {
    async authorize(request) {
      const grant = await resolver.resolve(request);
      if (
        grant === null ||
        (grant.projectRole !== "OWNER" && grant.projectRole !== "EDITOR")
      ) {
        throw new ProjectAccessDeniedError();
      }
      if (grant.principalType === "AGENT" && isAgentPlanChange(request.command)) {
        throw new AgentPlanApprovalRequiredError();
      }
      if (grant.principalType === "AGENT" && !canAgentApply(request, grant)) {
        throw new ProjectAccessDeniedError();
      }
      return { type: grant.principalType, id: grant.principalId };
    },
  };
}

export function createProjectQueryAuthorizer(
  resolver: ProjectAccessGrantResolver,
): ProjectQueryAuthorizer {
  return {
    async authorize(request) {
      const grant = await resolver.resolve(request);
      if (grant === null) throw new ProjectAccessDeniedError();
      return grant;
    },
  };
}

export function createScenarioMutationAuthorizer(
  resolver: ProjectAccessGrantResolver,
): ScenarioMutationAuthorizer {
  return {
    async authorize(request) {
      const grant = await resolver.resolve(request);
      if (
        grant === null ||
        (grant.projectRole !== "OWNER" && grant.projectRole !== "EDITOR")
      ) {
        throw new ProjectAccessDeniedError();
      }
      if (grant.principalType === "AGENT") {
        throw new AgentPlanApprovalRequiredError();
      }
      return { type: "HUMAN", id: grant.principalId };
    },
  };
}

export function createStaffingProposalAuthorizer(
  resolver: ProjectAccessGrantResolver,
): StaffingProposalAuthorizer {
  return {
    async authorize(request) {
      const grant = await resolver.resolve(request);
      if (
        grant === null ||
        (grant.projectRole !== "OWNER" && grant.projectRole !== "EDITOR")
      ) {
        throw new ProjectAccessDeniedError();
      }
      if (grant.principalType === "AGENT") {
        const scope = "project:staffing:propose";
        if (!grant.allowedScopes.includes(scope) || !request.identity.scopes.includes(scope)) {
          throw new ProjectAccessDeniedError();
        }
      }
      return { type: grant.principalType, id: grant.principalId };
    },
  };
}
