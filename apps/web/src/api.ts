import {
  type AuthenticatedIdentity,
  type ProjectCommandAuthorizer,
  type ProjectCommandService,
  type ProjectQueryAuthorizer,
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
      await session.performance.refresh(tenantId, projectId);
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
