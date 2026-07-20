import {
  applyProjectCommand,
  type ProjectCommand,
  type ProjectState,
} from "./project-state.js";

export interface AuditActor {
  readonly type: "HUMAN" | "AGENT" | "SYSTEM";
  readonly id: string;
}

export interface ProjectCommandRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
  readonly actor: AuditActor;
  readonly command: ProjectCommand;
}

export interface ProjectCommandExecution {
  readonly projectId: string;
  readonly revision: bigint;
  readonly replayed: boolean;
}

export interface ProjectCommandUnitOfWork {
  execute(
    request: ProjectCommandRequest,
    transition: (project: ProjectState) => ProjectState,
  ): Promise<ProjectCommandExecution>;
}

export interface ProjectCommandService {
  execute(request: ProjectCommandRequest): Promise<ProjectCommandExecution>;
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectVersionConflictError extends Error {
  constructor(
    readonly expectedRevision: bigint,
    readonly actualRevision: bigint,
  ) {
    super(`Project revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "ProjectVersionConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key was reused for a different command: ${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}

export class ProjectCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectCommandValidationError";
  }
}

export function createProjectCommandService(
  unitOfWork: ProjectCommandUnitOfWork,
): ProjectCommandService {
  return {
    execute(request) {
      if (
        request.tenantId.trim().length === 0 ||
        request.projectId.trim().length === 0 ||
        request.idempotencyKey.trim().length === 0 ||
        request.actor.id.trim().length === 0 ||
        request.expectedRevision < 0n
      ) {
        throw new Error("Project command envelope is invalid");
      }

      return unitOfWork.execute(request, (project) => {
        if (project.id !== request.projectId) {
          throw new Error(`Loaded project does not match command: ${request.projectId}`);
        }
        try {
          return applyProjectCommand(project, request.command);
        } catch (error) {
          throw new ProjectCommandValidationError(
            error instanceof Error ? error.message : "Project command is invalid",
          );
        }
      });
    },
  };
}
