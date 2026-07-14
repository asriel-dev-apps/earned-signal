import {
  ActualValueDecreaseError,
  AgentPlanApprovalRequiredError,
  IdempotencyConflictError,
  ProjectAccessDeniedError,
  ProjectCommandValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type AuthenticatedIdentity,
  type ProjectCommand,
  type ProjectCommandAuthorizer,
  type ProjectCommandService,
  type ProjectTask,
} from "@earned-signal/application";
import { MAX_ACTIVITY_DURATION_WORKING_DAYS } from "@earned-signal/domain";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { AuthenticationRequiredError } from "./oidc-auth.js";

export interface ProjectCommandSession {
  readonly service: ProjectCommandService;
  readonly authorizer: ProjectCommandAuthorizer;
  close(): Promise<void>;
}

export interface ApiDependencies {
  authenticate(request: Request, environment: Env): Promise<AuthenticatedIdentity>;
  openCommandSession(environment: Env): Promise<ProjectCommandSession>;
}

const UuidSchema = z.string().uuid();
const RevisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const MinorUnitSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const ProgressBasisPointsSchema = z.number().int().min(0).max(10_000);
const MeasurementMethodSchema = z.enum(["ZERO_HUNDRED", "PHYSICAL_PERCENT"]);
const DurationSchema = z.number().int().min(1).max(MAX_ACTIVITY_DURATION_WORKING_DAYS);

const TaskChangesSchema = z
  .object({
    wbs: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    owner: z.string().optional(),
    durationWorkingDays: DurationSchema.optional(),
    measurementMethod: MeasurementMethodSchema.optional(),
    predecessorId: UuidSchema.nullable().optional(),
    budgetMinor: MinorUnitSchema.optional(),
    progressBasisPoints: ProgressBasisPointsSchema.optional(),
    actualCostMinor: MinorUnitSchema.optional(),
    actualMinutes: z.number().int().nonnegative().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

const TaskSchema = z.object({
  id: UuidSchema,
  wbs: z.string().trim().min(1),
  name: z.string().trim().min(1),
  owner: z.string(),
  durationWorkingDays: DurationSchema,
  measurementMethod: MeasurementMethodSchema,
  predecessorId: UuidSchema.nullable(),
  budgetMinor: MinorUnitSchema,
  progressBasisPoints: ProgressBasisPointsSchema,
  actualCostMinor: MinorUnitSchema,
  actualMinutes: z.number().int().nonnegative(),
});

const ApiCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.update"),
    taskId: UuidSchema,
    changes: TaskChangesSchema,
  }),
  z.object({ type: z.literal("task.add"), task: TaskSchema }),
  z.object({ type: z.literal("task.delete"), taskId: UuidSchema }),
]);

const CommandRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    command: ApiCommandSchema,
  })
  .openapi("ProjectCommandRequest");

const CommandResponseSchema = z
  .object({
    projectId: UuidSchema,
    revision: RevisionSchema,
    replayed: z.boolean(),
  })
  .openapi("ProjectCommandResponse");

const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      expectedRevision: RevisionSchema.optional(),
      actualRevision: RevisionSchema.optional(),
    }),
  })
  .openapi("ErrorResponse");

const commandRoute = createRoute({
  method: "post",
  path: "/api/tenants/{tenantId}/projects/{projectId}/commands",
  security: [{ OidcBearer: [] }],
  request: {
    params: z.object({
      tenantId: UuidSchema.openapi({ param: { name: "tenantId", in: "path" } }),
      projectId: UuidSchema.openapi({ param: { name: "projectId", in: "path" } }),
    }),
    headers: z.object({
      "Idempotency-Key": z.string().trim().min(1).max(200).openapi({
        param: { name: "Idempotency-Key", in: "header" },
      }),
    }),
    body: {
      required: true,
      content: { "application/json": { schema: CommandRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Command executed or replayed",
      content: { "application/json": { schema: CommandResponseSchema } },
    },
    400: {
      description: "Malformed command request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Authenticated principal is not permitted to run the command",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Revision or idempotency conflict",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    413: {
      description: "Command body is too large",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Command violates project invariants",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

function asSafeMinorUnits(value: string, field: string): number {
  const parsed = BigInt(value);
  const result = Number(parsed);
  if (!Number.isSafeInteger(result)) {
    throw new ProjectCommandValidationError(`${field} exceeds the supported API range`);
  }
  return result;
}

function toTask(task: z.infer<typeof TaskSchema>): ProjectTask {
  return {
    id: task.id,
    wbs: task.wbs,
    name: task.name,
    owner: task.owner,
    durationWorkingDays: task.durationWorkingDays,
    measurementMethod: task.measurementMethod,
    predecessorId: task.predecessorId,
    budget: asSafeMinorUnits(task.budgetMinor, "budgetMinor"),
    progressPercent: task.progressBasisPoints / 100,
    actualCost: asSafeMinorUnits(task.actualCostMinor, "actualCostMinor"),
    actualMinutes: task.actualMinutes,
  };
}

function toCommand(command: z.infer<typeof ApiCommandSchema>): ProjectCommand {
  if (command.type === "task.add") {
    return { type: command.type, task: toTask(command.task) };
  }
  if (command.type === "task.delete") {
    return command;
  }

  const changes = {
    ...(command.changes.wbs === undefined ? {} : { wbs: command.changes.wbs }),
    ...(command.changes.name === undefined ? {} : { name: command.changes.name }),
    ...(command.changes.owner === undefined ? {} : { owner: command.changes.owner }),
    ...(command.changes.durationWorkingDays === undefined
      ? {}
      : { durationWorkingDays: command.changes.durationWorkingDays }),
    ...(command.changes.measurementMethod === undefined
      ? {}
      : { measurementMethod: command.changes.measurementMethod }),
    ...(command.changes.predecessorId === undefined
      ? {}
      : { predecessorId: command.changes.predecessorId }),
    ...(command.changes.budgetMinor === undefined
      ? {}
      : { budget: asSafeMinorUnits(command.changes.budgetMinor, "budgetMinor") }),
    ...(command.changes.progressBasisPoints === undefined
      ? {}
      : { progressPercent: command.changes.progressBasisPoints / 100 }),
    ...(command.changes.actualCostMinor === undefined
      ? {}
      : {
          actualCost: asSafeMinorUnits(
            command.changes.actualCostMinor,
            "actualCostMinor",
          ),
        }),
    ...(command.changes.actualMinutes === undefined
      ? {}
      : { actualMinutes: command.changes.actualMinutes }),
  } satisfies Partial<Omit<ProjectTask, "id">>;
  return { type: command.type, taskId: command.taskId, changes };
}

export function createApiApp(dependencies: ApiDependencies) {
  const app = new OpenAPIHono<{ Bindings: Env }>({
    defaultHook: (result, context) => {
      if (!result.success) {
        return context.json(
          { error: { code: "REQUEST_INVALID", message: "Request validation failed" } },
          400,
        );
      }
    },
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "OidcBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "OIDC access token issued for the EarnedSignal API audience",
  });

  app.get("/api/health", (context) =>
    context.json({ service: "earned-signal", status: "ok" }),
  );

  app.use(
    "/api/tenants/:tenantId/projects/:projectId/commands",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json(
          { error: { code: "BODY_TOO_LARGE", message: "Request body exceeds 64 KiB" } },
          413,
        ),
    }),
  );

  app.use(
    "/api/tenants/:tenantId/projects/:projectId/commands",
    async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    },
  );

  app.openapi(commandRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const headers = context.req.valid("header");
    const body = context.req.valid("json");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openCommandSession(context.env);
    try {
      const command = toCommand(body.command);
      const actor = await session.authorizer.authorize({
        identity,
        tenantId,
        projectId,
        command,
      });
      const result = await session.service.execute({
        tenantId,
        projectId,
        expectedRevision: BigInt(body.expectedRevision),
        idempotencyKey: headers["Idempotency-Key"],
        actor,
        command,
      });
      context.header("ETag", `"${result.revision}"`);
      context.header("Cache-Control", "no-store");
      return context.json(
        {
          projectId: result.projectId,
          revision: result.revision.toString(),
          replayed: result.replayed,
        },
        200,
      );
    } finally {
      await session.close();
    }
  });

  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "EarnedSignal API", version: "0.1.0" },
  });

  app.onError((error, context) => {
    if (error instanceof AuthenticationRequiredError) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: { code: "AUTHENTICATION_REQUIRED", message: error.message } }, 401);
    }
    if (error instanceof AgentPlanApprovalRequiredError) {
      return context.json(
        { error: { code: "AGENT_APPROVAL_REQUIRED", message: error.message } },
        403,
      );
    }
    if (error instanceof ProjectAccessDeniedError) {
      return context.json(
        { error: { code: "PROJECT_ACCESS_DENIED", message: error.message } },
        403,
      );
    }
    if (error instanceof ProjectNotFoundError) {
      return context.json({ error: { code: "PROJECT_NOT_FOUND", message: error.message } }, 404);
    }
    if (error instanceof ProjectVersionConflictError) {
      return context.json(
        {
          error: {
            code: "VERSION_CONFLICT",
            message: error.message,
            expectedRevision: error.expectedRevision.toString(),
            actualRevision: error.actualRevision.toString(),
          },
        },
        409,
      );
    }
    if (error instanceof IdempotencyConflictError) {
      return context.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: error.message } }, 409);
    }
    if (
      error instanceof ProjectCommandValidationError ||
      error instanceof ActualValueDecreaseError
    ) {
      return context.json({ error: { code: "COMMAND_INVALID", message: error.message } }, 422);
    }
    console.error(
      JSON.stringify({
        message: "Unhandled API error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return context.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      500,
    );
  });

  return app;
}
