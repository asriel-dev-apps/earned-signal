import {
  type AuthenticatedIdentity,
  type ProjectCommandAuthorizer,
  type ProjectCommandService,
  type ProjectQueryAuthorizer,
  type ProjectState,
} from "@earned-signal/application";
import type { EvmSnapshot } from "@earned-signal/domain";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { AuthenticationRequiredError } from "./oidc-auth.js";
import {
  ApiCommandSchema,
  RevisionSchema,
  UuidSchema,
  toCommand,
} from "./project-command-contract.js";
import { resolveProjectCommandError } from "./project-command-error.js";

export interface ProjectSession {
  readonly service: ProjectCommandService;
  readonly authorizer: ProjectCommandAuthorizer;
  readonly queryAuthorizer: ProjectQueryAuthorizer;
  readonly performance: {
    calculate(tenantId: string, projectId: string): Promise<readonly EvmSnapshot[]>;
    refresh(tenantId: string, projectId: string): Promise<readonly EvmSnapshot[]>;
  };
  readonly workspace: {
    load(tenantId: string, projectId: string): Promise<{
      readonly revision: bigint;
      readonly current: ProjectState;
      readonly baseline: ProjectState | null;
      readonly baselineVersion: { readonly id: string; readonly version: number; readonly label: string; readonly approvedAt: string } | null;
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

const EvmMetricsSchema = z.object({
  bac: z.number(),
  pv: z.number(),
  ev: z.number(),
  ac: z.number(),
  sv: z.number(),
  cv: z.number(),
  spi: z.number().nullable(),
  cpi: z.number().nullable(),
  eac: z.number().nullable(),
  etc: z.number().nullable(),
  vac: z.number().nullable(),
  tcpi: z.number().nullable(),
});

const ProjectStateResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  projectStart: z.iso.date(),
  statusDate: z.iso.date(),
  currency: z.literal("JPY"),
  defaultCalendarId: z.string(),
  calendars: z.array(z.object({ id: z.string(), name: z.string(), workingWeekdays: z.array(z.number().int()), nonWorkingDates: z.array(z.iso.date()) })),
  wbsGroups: z.array(z.object({ id: UuidSchema, parentId: UuidSchema.nullable(), code: z.string(), name: z.string() })),
  skills: z.array(z.object({ id: UuidSchema, name: z.string() })),
  resources: z.array(z.object({ id: UuidSchema, name: z.string(), calendarId: z.string(), dailyCapacityMinutes: z.number().int(), costRateMinorPerHour: z.number().int(), skillIds: z.array(UuidSchema) })),
  assignments: z.array(z.object({ taskId: UuidSchema, resourceId: UuidSchema, unitsPercent: z.number().int() })),
  tasks: z.array(z.object({
    id: UuidSchema,
    wbs: z.string(),
    wbsParentId: UuidSchema.nullable(),
    name: z.string(),
    owner: z.string(),
    durationWorkingDays: z.number().int(),
    measurementMethod: z.enum(["ZERO_HUNDRED", "PHYSICAL_PERCENT"]),
    calendarId: z.string(),
    dependencies: z.array(z.object({ predecessorId: UuidSchema, type: z.enum(["FS", "SS", "FF", "SF"]), lagWorkingDays: z.number().int() })),
    constraint: z.object({ type: z.enum(["START_NO_EARLIER_THAN", "FINISH_NO_LATER_THAN", "MUST_START_ON", "MUST_FINISH_ON"]), date: z.iso.date() }).nullable(),
    requiredSkillIds: z.array(UuidSchema),
    budget: z.number().int(),
    progressPercent: z.number(),
    actualCost: z.number().int(),
    actualMinutes: z.number().int(),
  })),
});

const WorkspaceResponseSchema = z.object({
  revision: RevisionSchema,
  current: ProjectStateResponseSchema,
  baseline: ProjectStateResponseSchema.nullable(),
  baselineVersion: z.object({ id: UuidSchema, version: z.number().int(), label: z.string(), approvedAt: z.string().datetime() }).nullable(),
}).openapi("ProjectWorkspaceResponse");

function projectStateResponse(project: ProjectState): z.infer<typeof ProjectStateResponseSchema> {
  return {
    ...project,
    calendars: project.calendars.map((calendar) => ({ ...calendar, workingWeekdays: [...calendar.workingWeekdays], nonWorkingDates: [...calendar.nonWorkingDates] })),
    wbsGroups: project.wbsGroups.map((group) => ({ ...group })),
    skills: project.skills.map((skill) => ({ ...skill })),
    resources: project.resources.map((resource) => ({ ...resource, skillIds: [...resource.skillIds] })),
    assignments: project.assignments.map((assignment) => ({ ...assignment })),
    tasks: project.tasks.map((task) => ({
      ...task,
      dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
      constraint: task.constraint === null ? null : { ...task.constraint },
      requiredSkillIds: [...task.requiredSkillIds],
    })),
  };
}

const workspaceRoute = createRoute({
  method: "get",
  path: "/api/tenants/{tenantId}/projects/{projectId}",
  security: [{ OidcBearer: [] }],
  request: { params: z.object({
    tenantId: UuidSchema.openapi({ param: { name: "tenantId", in: "path" } }),
    projectId: UuidSchema.openapi({ param: { name: "projectId", in: "path" } }),
  }) },
  responses: {
    200: { description: "Persisted Current and approved Baseline workspace", content: { "application/json": { schema: WorkspaceResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Authenticated principal cannot read the project", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Project not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const PerformanceResponseSchema = z
  .object({
    snapshots: z.array(
      z.object({
        period: z.object({
          periodStart: z.iso.date(),
          periodEnd: z.iso.date(),
          statusDate: z.iso.date(),
        }),
        metrics: EvmMetricsSchema,
        wbsVariances: z.array(
          z.object({
            id: UuidSchema,
            wbs: z.string(),
            pv: z.number(),
            ev: z.number(),
            ac: z.number(),
            sv: z.number(),
            cv: z.number(),
          }),
        ),
      }),
    ),
  })
  .openapi("ProjectPerformanceResponse");

const performanceRoute = createRoute({
  method: "get",
  path: "/api/tenants/{tenantId}/projects/{projectId}/performance",
  security: [{ OidcBearer: [] }],
  request: {
    params: z.object({
      tenantId: UuidSchema.openapi({ param: { name: "tenantId", in: "path" } }),
      projectId: UuidSchema.openapi({ param: { name: "projectId", in: "path" } }),
    }),
  },
  responses: {
    200: {
      description: "Weekly EVM snapshots and ranked WBS variances",
      content: { "application/json": { schema: PerformanceResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Authenticated principal cannot read the project",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

function performanceResponse(snapshots: readonly EvmSnapshot[]) {
  return {
    snapshots: snapshots.map((snapshot) => ({
      period: { ...snapshot.period },
      metrics: { ...snapshot.metrics },
      wbsVariances: snapshot.wbsVariances.map((variance) => ({ ...variance })),
    })),
  };
}

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
      try {
        await session.performance.refresh(tenantId, projectId);
      } catch (error) {
        console.error("Project command committed, but the derived performance cache could not be refreshed", error);
      }
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

  app.openapi(performanceRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      await session.queryAuthorizer.authorize({ identity, tenantId, projectId });
      context.header("Cache-Control", "no-store");
      return context.json(
        performanceResponse(await session.performance.calculate(tenantId, projectId)),
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
      await session.queryAuthorizer.authorize({ identity, tenantId, projectId });
      const workspace = await session.workspace.load(tenantId, projectId);
      if (workspace === null) return context.json({ error: { code: "PROJECT_NOT_FOUND", message: "Project was not found" } }, 404);
      context.header("Cache-Control", "no-store");
      context.header("ETag", `"${workspace.revision}"`);
      return context.json({
        revision: workspace.revision.toString(),
        current: projectStateResponse(workspace.current),
        baseline: workspace.baseline === null ? null : projectStateResponse(workspace.baseline),
        baselineVersion: workspace.baselineVersion === null ? null : { ...workspace.baselineVersion },
      }, 200);
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
    const resolution = resolveProjectCommandError(error);
    if (resolution !== null) {
      return context.json({ error: resolution.error }, resolution.status);
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
