import {
  ActualValueDecreaseError,
  AgentPlanApprovalRequiredError,
  IdempotencyConflictError,
  ProjectAccessDeniedError,
  ProjectCommandValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
} from "@earned-signal/application";

export interface ProjectCommandErrorBody {
  readonly code: string;
  readonly message: string;
  readonly expectedRevision?: string;
  readonly actualRevision?: string;
}

export interface ProjectCommandErrorResolution {
  readonly status: 403 | 404 | 409 | 422;
  readonly error: ProjectCommandErrorBody;
}

export function resolveProjectCommandError(
  error: unknown,
): ProjectCommandErrorResolution | null {
  if (error instanceof AgentPlanApprovalRequiredError) {
    return {
      status: 403,
      error: { code: "AGENT_APPROVAL_REQUIRED", message: error.message },
    };
  }
  if (error instanceof ProjectAccessDeniedError) {
    return {
      status: 403,
      error: { code: "PROJECT_ACCESS_DENIED", message: error.message },
    };
  }
  if (error instanceof ProjectNotFoundError) {
    return { status: 404, error: { code: "PROJECT_NOT_FOUND", message: error.message } };
  }
  if (error instanceof ProjectVersionConflictError) {
    return {
      status: 409,
      error: {
        code: "VERSION_CONFLICT",
        message: error.message,
        expectedRevision: error.expectedRevision.toString(),
        actualRevision: error.actualRevision.toString(),
      },
    };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: 409,
      error: { code: "IDEMPOTENCY_CONFLICT", message: error.message },
    };
  }
  if (
    error instanceof ProjectCommandValidationError ||
    error instanceof ActualValueDecreaseError
  ) {
    return { status: 422, error: { code: "COMMAND_INVALID", message: error.message } };
  }
  return null;
}
