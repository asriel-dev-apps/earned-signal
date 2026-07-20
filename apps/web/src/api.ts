import {
  projectionRoleForProjectRole,
  projectWbsGrid,
  projectWorkspaceView,
  type AuthenticatedIdentity,
  type ProjectCommandAuthorizer,
  type ProjectCommandService,
  type ProjectQueryAuthorizer,
  type ProjectState,
  type ProjectStateView,
  type WbsGridProjection,
} from "@earned-signal/application";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { AuthenticationRequiredError } from "./oidc-auth.js";
import { ApiCommandSchema, RevisionSchema, UuidSchema, toCommand } from "./project-command-contract.js";
import { resolveProjectCommandError } from "./project-command-error.js";
import { errorName, rateLimitedResponse, RequestRateLimitedError } from "./edge-security.js";

export interface ProjectSession {
  readonly service: ProjectCommandService;
  readonly authorizer: ProjectCommandAuthorizer;
  readonly queryAuthorizer: ProjectQueryAuthorizer;
  readonly workspace: {
    load(tenantId: string, projectId: string): Promise<{
      readonly revision: bigint;
      readonly current: ProjectState;
    } | null>;
  };
  close(): Promise<void>;
}

export interface ApiDependencies {
  authenticate(request: Request, environment: Env): Promise<AuthenticatedIdentity>;
  openProjectSession(environment: Env): Promise<ProjectSession>;
}

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

const CalendarSchema = z.object({
  id: z.string(),
  name: z.string(),
  workingWeekdays: z.array(z.number().int()),
  nonWorkingDates: z.array(z.iso.date()),
});

// dailyCapacityMinutes is a privileged-only field: the general read model omits
// the key entirely (⑦ / ADR 0011 D18), so the response contract marks it
// optional rather than nullable.
const MemberResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  calendarId: z.string(),
  dailyCapacityMinutes: z.number().int().optional(),
});

const DependencyResponseSchema = z.object({
  predecessorId: UuidSchema,
  type: z.enum(["FS", "SS", "FF", "SF"]),
  lagWorkingDays: z.number().int(),
});

const TaskResponseSchema = z.object({
  id: UuidSchema,
  parentId: UuidSchema.nullable(),
  sortOrder: z.number().int(),
  name: z.string(),
  process: z.string(),
  product: z.string(),
  reviewRef: z.string(),
  changeRef: z.string(),
  note: z.string(),
  contract: z.string(),
  assigneeMemberId: UuidSchema.nullable(),
  plannedEffortMinutes: z.number().int(),
  progressBasisPoints: z.number().int(),
  actualEffortMinutes: z.number().int(),
  dailyPlan: z.record(z.iso.date(), z.number()),
  dailyPlanLocked: z.boolean(),
  actualStart: z.iso.date().nullable(),
  actualFinish: z.iso.date().nullable(),
  dependencies: z.array(DependencyResponseSchema),
});

const ProjectStateResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  projectStart: z.iso.date(),
  statusDate: z.iso.date(),
  currency: z.literal("JPY"),
  defaultCalendarId: z.string(),
  calendars: z.array(CalendarSchema),
  members: z.array(MemberResponseSchema),
  tasks: z.array(TaskResponseSchema),
});

const WorkspaceResponseSchema = z
  .object({ revision: RevisionSchema, current: ProjectStateResponseSchema })
  .openapi("ProjectWorkspaceResponse");

const EffortRatioSchema = z.union([z.number(), z.literal("-")]);

const EffortRollupSchema = z.object({
  bac: z.number(),
  pv: z.number(),
  ev: z.number(),
  ac: z.number(),
  sv: z.number(),
  cv: z.number(),
  spi: EffortRatioSchema,
  cpi: EffortRatioSchema,
});

const WbsGridRowSchema = z.object({
  id: UuidSchema,
  parentId: UuidSchema.nullable(),
  sortOrder: z.number().int(),
  name: z.string(),
  process: z.string(),
  product: z.string(),
  reviewRef: z.string(),
  changeRef: z.string(),
  note: z.string(),
  contract: z.string(),
  assigneeMemberId: UuidSchema.nullable(),
  assigneeName: z.string().nullable(),
  plannedEffortMinutes: z.number().int(),
  progressBasisPoints: z.number().int(),
  actualEffortMinutes: z.number().int(),
  actualStart: z.iso.date().nullable(),
  actualFinish: z.iso.date().nullable(),
  dailyPlan: z.record(z.iso.date(), z.number()),
  dailyPlanLocked: z.boolean(),
  plannedEffortDays: z.number(),
  plannedEffortHours: z.number(),
  plannedEarnedHours: z.number(),
  plannedProgress: z.number(),
  plannedStart: z.iso.date().nullable(),
  plannedFinish: z.iso.date().nullable(),
  progress: z.number(),
  status: z.enum(["NOT_STARTED", "IN_PROGRESS", "DONE"]),
  earnedEffortHours: z.number(),
  actualEffortHours: z.number(),
  costVarianceHours: z.number(),
});

const WbsGridResponseSchema = z
  .object({
    projectId: UuidSchema,
    statusDate: z.iso.date(),
    rows: z.array(WbsGridRowSchema),
    rollup: EffortRollupSchema,
  })
  .openapi("ProjectWbsGridResponse");

function projectStateResponse(project: ProjectStateView): z.infer<typeof ProjectStateResponseSchema> {
  return {
    id: project.id,
    name: project.name,
    projectStart: project.projectStart,
    statusDate: project.statusDate,
    currency: project.currency,
    defaultCalendarId: project.defaultCalendarId,
    calendars: project.calendars.map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      workingWeekdays: [...calendar.workingWeekdays],
      nonWorkingDates: [...calendar.nonWorkingDates],
    })),
    // Spread keeps the general member absent of dailyCapacityMinutes: the view
    // has already removed the key, so it never reaches the JSON response.
    members: project.members.map((member) => ({ ...member })),
    tasks: project.tasks.map((task) => ({
      ...task,
      dailyPlan: { ...task.dailyPlan },
      dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
    })),
  };
}

function wbsGridResponse(projection: WbsGridProjection): z.infer<typeof WbsGridResponseSchema> {
  return {
    projectId: projection.projectId,
    statusDate: projection.statusDate,
    rows: projection.rows.map((row) => ({ ...row, dailyPlan: { ...row.dailyPlan } })),
    rollup: { ...projection.rollup },
  };
}

const workspaceRoute = createRoute({
  method: "get",
  path: "/api/tenants/{tenantId}/projects/{projectId}",
  security: [{ OidcBearer: [] }],
  request: {
    params: z.object({
      tenantId: UuidSchema.openapi({ param: { name: "tenantId", in: "path" } }),
      projectId: UuidSchema.openapi({ param: { name: "projectId", in: "path" } }),
    }),
  },
  responses: {
    200: { description: "Persisted Current workspace", content: { "application/json": { schema: WorkspaceResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Authenticated principal cannot read the project", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Project not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const wbsGridRoute = createRoute({
  method: "get",
  path: "/api/tenants/{tenantId}/projects/{projectId}/wbs-grid",
  security: [{ OidcBearer: [] }],
  request: {
    params: z.object({
      tenantId: UuidSchema.openapi({ param: { name: "tenantId", in: "path" } }),
      projectId: UuidSchema.openapi({ param: { name: "projectId", in: "path" } }),
    }),
  },
  responses: {
    200: { description: "Effort WBS grid: 23-column rows with derived metrics and the project rollup", content: { "application/json": { schema: WbsGridResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Authenticated principal cannot read the project", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Project not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

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
    200: { description: "Command executed or replayed", content: { "application/json": { schema: CommandResponseSchema } } },
    400: { description: "Malformed command request", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Authenticated principal is not permitted to run the command", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Project not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "Revision or idempotency conflict", content: { "application/json": { schema: ErrorResponseSchema } } },
    413: { description: "Command body is too large", content: { "application/json": { schema: ErrorResponseSchema } } },
    422: { description: "Command violates project invariants", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

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

  for (const path of [
    "/api/tenants/:tenantId/projects/:projectId/commands",
    "/api/tenants/:tenantId/projects/:projectId/wbs-grid",
  ]) {
    app.use(path, async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    });
  }

  app.openapi(commandRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const headers = context.req.valid("header");
    const body = context.req.valid("json");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
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

  app.openapi(workspaceRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      const grant = await session.queryAuthorizer.authorize({ identity, tenantId, projectId });
      const workspace = await session.workspace.load(tenantId, projectId);
      if (workspace === null) {
        return context.json({ error: { code: "PROJECT_NOT_FOUND", message: "Project was not found" } }, 404);
      }
      context.header("Cache-Control", "no-store");
      context.header("ETag", `"${workspace.revision}"`);
      const view = projectWorkspaceView(
        workspace.current,
        projectionRoleForProjectRole(grant.projectRole),
      );
      return context.json({
        revision: workspace.revision.toString(),
        current: projectStateResponse(view),
      }, 200);
    } finally {
      await session.close();
    }
  });

  app.openapi(wbsGridRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      const grant = await session.queryAuthorizer.authorize({ identity, tenantId, projectId });
      const workspace = await session.workspace.load(tenantId, projectId);
      if (workspace === null) {
        return context.json({ error: { code: "PROJECT_NOT_FOUND", message: "Project was not found" } }, 404);
      }
      context.header("Cache-Control", "no-store");
      context.header("ETag", `"${workspace.revision}"`);
      const projection = projectWbsGrid(workspace.current, {
        role: projectionRoleForProjectRole(grant.projectRole),
      });
      return context.json(wbsGridResponse(projection), 200);
    } finally {
      await session.close();
    }
  });

  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "EarnedSignal API", version: "0.1.0" },
  });

  app.onError((error, context) => {
    if (error instanceof RequestRateLimitedError) return rateLimitedResponse();
    if (error instanceof AuthenticationRequiredError) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: { code: "AUTHENTICATION_REQUIRED", message: error.message } }, 401);
    }
    const resolution = resolveProjectCommandError(error);
    if (resolution !== null) {
      return context.json({ error: resolution.error }, resolution.status);
    }
    console.error(
      JSON.stringify({
        event: "api_unhandled_error",
        requestId: context.req.header("x-request-id") ?? "unknown",
        errorName: errorName(error),
      }),
    );
    return context.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      500,
    );
  });

  return app;
}
