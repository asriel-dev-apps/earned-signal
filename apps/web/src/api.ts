import {
  calculateScenario,
  type AuthenticatedIdentity,
  type ProjectCommandAuthorizer,
  type ProjectCommandService,
  type ProjectQueryAuthorizer,
  type ProjectState,
  ProjectNotFoundError,
  type ScenarioMutationAuthorizer,
  type StaffingProposalSubmissionService,
  type ScenarioPlanCommand,
  ProjectCommandValidationError,
} from "@earned-signal/application";
import type { EvmSnapshot } from "@earned-signal/domain";
import {
  ScenarioNotFoundError,
  ScenarioRevisionConflictError,
  ScenarioRunRequiredError,
  ScenarioTerminalError,
  StaffingProposalNotFoundError,
  type StaffingProposal,
  type ProjectScenario,
  type ProjectScenarioRepository,
  type ProjectStaffingProposalRepository,
  type ScenarioJson,
  type ScenarioPlanChange,
} from "@earned-signal/persistence";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { AuthenticationRequiredError } from "./oidc-auth.js";
import {
  ApiCommandSchema,
  RevisionSchema,
  ScenarioPlanCommandSchema,
  UuidSchema,
  toCommand,
} from "./project-command-contract.js";
import { resolveProjectCommandError } from "./project-command-error.js";
import { ScenarioResponseSchema, ScenarioResultSchema } from "./scenario-response-contract.js";
import {
  StaffingProposalCreateSchema,
  StaffingProposalResponseSchema,
  staffingProposalResponse,
} from "./staffing-contract.js";

export interface ProjectSession {
  readonly service: ProjectCommandService;
  readonly authorizer: ProjectCommandAuthorizer;
  readonly queryAuthorizer: ProjectQueryAuthorizer;
  readonly scenarioAuthorizer: ScenarioMutationAuthorizer;
  readonly staffingSubmission: StaffingProposalSubmissionService<StaffingProposal>;
  readonly scenarios: Pick<
    ProjectScenarioRepository,
    "list" | "load" | "create" | "updateChanges" | "saveRun" | "discard"
  >;
  readonly staffingProposals: Pick<ProjectStaffingProposalRepository, "list" | "load">;
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

const SCENARIO_ALGORITHM_VERSION = "deterministic-trend-v1";

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

const StaffingProposalParamsSchema = z.object({
  tenantId: UuidSchema.openapi({ param: { name: "tenantId", in: "path" } }),
  projectId: UuidSchema.openapi({ param: { name: "projectId", in: "path" } }),
});

const staffingProposalListRoute = createRoute({
  method: "get",
  path: "/api/tenants/{tenantId}/projects/{projectId}/staffing-proposals",
  security: [{ OidcBearer: [] }],
  request: { params: StaffingProposalParamsSchema },
  responses: {
    200: { description: "Project Staffing Proposals", content: { "application/json": { schema: z.object({ proposals: z.array(StaffingProposalResponseSchema) }) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Project access denied", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const staffingProposalCreateRoute = createRoute({
  method: "post",
  path: "/api/tenants/{tenantId}/projects/{projectId}/staffing-proposals",
  security: [{ OidcBearer: [] }],
  request: {
    params: StaffingProposalParamsSchema,
    headers: z.object({
      "Idempotency-Key": z.string().trim().min(1).max(200).openapi({ param: { name: "Idempotency-Key", in: "header" } }),
    }),
    body: { required: true, content: { "application/json": { schema: StaffingProposalCreateSchema } } },
  },
  responses: {
    202: { description: "Staffing Proposal accepted", content: { "application/json": { schema: z.object({ proposal: StaffingProposalResponseSchema, replayed: z.boolean() }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Proposal denied", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "Revision or idempotency conflict", content: { "application/json": { schema: ErrorResponseSchema } } },
    413: { description: "Body too large", content: { "application/json": { schema: ErrorResponseSchema } } },
    422: { description: "Proposal cannot be accepted", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const staffingProposalLoadRoute = createRoute({
  method: "get",
  path: "/api/tenants/{tenantId}/projects/{projectId}/staffing-proposals/{proposalId}",
  security: [{ OidcBearer: [] }],
  request: { params: StaffingProposalParamsSchema.extend({
    proposalId: UuidSchema.openapi({ param: { name: "proposalId", in: "path" } }),
  }) },
  responses: {
    200: { description: "Staffing Proposal", content: { "application/json": { schema: StaffingProposalResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Project access denied", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Staffing Proposal not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

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

const ScenarioParamsSchema = z.object({
  tenantId: UuidSchema.openapi({ param: { name: "tenantId", in: "path" } }),
  projectId: UuidSchema.openapi({ param: { name: "projectId", in: "path" } }),
});
const ScenarioIdentityParamsSchema = ScenarioParamsSchema.extend({
  scenarioId: UuidSchema.openapi({ param: { name: "scenarioId", in: "path" } }),
});
const ScenarioChangesSchema = z.array(ScenarioPlanCommandSchema).max(500);
const ScenarioCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  changes: ScenarioChangesSchema.default([]),
});
const ScenarioUpdateSchema = z.object({
  expectedRevision: RevisionSchema,
  changes: ScenarioChangesSchema,
});
const ScenarioRevisionSchema = z.object({ expectedRevision: RevisionSchema });
const ScenarioPublishSchema = z.object({
  expectedProjectRevision: RevisionSchema,
  expectedScenarioRevision: RevisionSchema,
});

const scenarioListRoute = createRoute({
  method: "get", path: "/api/tenants/{tenantId}/projects/{projectId}/scenarios",
  security: [{ OidcBearer: [] }], request: { params: ScenarioParamsSchema },
  responses: { 200: { description: "Project scenarios", content: { "application/json": { schema: z.object({ scenarios: z.array(ScenarioResponseSchema) }) } } }, 401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } }, 403: { description: "Project access denied", content: { "application/json": { schema: ErrorResponseSchema } } } },
});
const scenarioCreateRoute = createRoute({
  method: "post", path: "/api/tenants/{tenantId}/projects/{projectId}/scenarios",
  security: [{ OidcBearer: [] }], request: { params: ScenarioParamsSchema, body: { required: true, content: { "application/json": { schema: ScenarioCreateSchema } } } },
  responses: { 201: { description: "Created draft scenario", content: { "application/json": { schema: ScenarioResponseSchema } } }, 400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } }, 403: { description: "Mutation denied", content: { "application/json": { schema: ErrorResponseSchema } } }, 409: { description: "Project revision conflict", content: { "application/json": { schema: ErrorResponseSchema } } }, 413: { description: "Body too large", content: { "application/json": { schema: ErrorResponseSchema } } } },
});
const scenarioLoadRoute = createRoute({
  method: "get", path: "/api/tenants/{tenantId}/projects/{projectId}/scenarios/{scenarioId}",
  security: [{ OidcBearer: [] }], request: { params: ScenarioIdentityParamsSchema },
  responses: { 200: { description: "Scenario", content: { "application/json": { schema: ScenarioResponseSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } }, 403: { description: "Project access denied", content: { "application/json": { schema: ErrorResponseSchema } } }, 404: { description: "Scenario not found", content: { "application/json": { schema: ErrorResponseSchema } } } },
});
const scenarioUpdateRoute = createRoute({
  method: "patch", path: "/api/tenants/{tenantId}/projects/{projectId}/scenarios/{scenarioId}",
  security: [{ OidcBearer: [] }], request: { params: ScenarioIdentityParamsSchema, body: { required: true, content: { "application/json": { schema: ScenarioUpdateSchema } } } },
  responses: { 200: { description: "Updated scenario", content: { "application/json": { schema: ScenarioResponseSchema } } }, 400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } }, 403: { description: "Mutation denied", content: { "application/json": { schema: ErrorResponseSchema } } }, 409: { description: "Revision or state conflict", content: { "application/json": { schema: ErrorResponseSchema } } }, 413: { description: "Body too large", content: { "application/json": { schema: ErrorResponseSchema } } } },
});
const scenarioRunRoute = createRoute({
  method: "post", path: "/api/tenants/{tenantId}/projects/{projectId}/scenarios/{scenarioId}/runs",
  security: [{ OidcBearer: [] }], request: { params: ScenarioIdentityParamsSchema, body: { required: true, content: { "application/json": { schema: ScenarioRevisionSchema } } } },
  responses: { 200: { description: "Calculated immutable scenario run", content: { "application/json": { schema: ScenarioResponseSchema } } }, 400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } }, 403: { description: "Mutation denied", content: { "application/json": { schema: ErrorResponseSchema } } }, 404: { description: "Scenario or project not found", content: { "application/json": { schema: ErrorResponseSchema } } }, 409: { description: "Revision or stale conflict", content: { "application/json": { schema: ErrorResponseSchema } } }, 413: { description: "Body too large", content: { "application/json": { schema: ErrorResponseSchema } } }, 422: { description: "Scenario cannot be calculated", content: { "application/json": { schema: ErrorResponseSchema } } } },
});
const scenarioDiscardRoute = createRoute({
  method: "post", path: "/api/tenants/{tenantId}/projects/{projectId}/scenarios/{scenarioId}/discard",
  security: [{ OidcBearer: [] }], request: { params: ScenarioIdentityParamsSchema, body: { required: true, content: { "application/json": { schema: ScenarioRevisionSchema } } } },
  responses: { 200: { description: "Discarded scenario", content: { "application/json": { schema: ScenarioResponseSchema } } }, 400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } }, 403: { description: "Mutation denied", content: { "application/json": { schema: ErrorResponseSchema } } }, 404: { description: "Scenario not found", content: { "application/json": { schema: ErrorResponseSchema } } }, 409: { description: "Revision or state conflict", content: { "application/json": { schema: ErrorResponseSchema } } }, 413: { description: "Body too large", content: { "application/json": { schema: ErrorResponseSchema } } } },
});
const scenarioPublishRoute = createRoute({
  method: "post", path: "/api/tenants/{tenantId}/projects/{projectId}/scenarios/{scenarioId}/publish",
  security: [{ OidcBearer: [] }], request: { params: ScenarioIdentityParamsSchema, headers: z.object({ "Idempotency-Key": z.string().trim().min(1).max(200).openapi({ param: { name: "Idempotency-Key", in: "header" } }) }), body: { required: true, content: { "application/json": { schema: ScenarioPublishSchema } } } },
  responses: { 200: { description: "Published Scenario into Current", content: { "application/json": { schema: CommandResponseSchema } } }, 400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } }, 401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } }, 403: { description: "Mutation denied", content: { "application/json": { schema: ErrorResponseSchema } } }, 404: { description: "Scenario not found", content: { "application/json": { schema: ErrorResponseSchema } } }, 409: { description: "Revision or state conflict", content: { "application/json": { schema: ErrorResponseSchema } } }, 413: { description: "Body too large", content: { "application/json": { schema: ErrorResponseSchema } } }, 422: { description: "Scenario cannot be published", content: { "application/json": { schema: ErrorResponseSchema } } } },
});

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

function isScenarioPlanCommand(command: ReturnType<typeof toCommand>): command is ScenarioPlanCommand {
  return command.type !== "baseline.publish" && command.type !== "scenario.publish";
}

function parseScenarioChanges(
  changes: readonly z.infer<typeof ScenarioPlanCommandSchema>[],
): readonly ScenarioPlanCommand[] {
  return changes.map((change) => {
    const command = toCommand(change);
    if (!isScenarioPlanCommand(command)) {
      throw new ProjectCommandValidationError("Scenario contains a non-plan command");
    }
    return command;
  });
}

function parseStoredScenarioChanges(
  changes: readonly ScenarioPlanChange[],
): readonly ScenarioPlanCommand[] {
  return changes.map((change) => {
    const knownTypes = new Set([
      "task.update", "task.add", "task.delete", "resource.add", "resource.update",
      "resource.delete", "assignment.replace",
    ]);
    if (!knownTypes.has(change.type)) {
      throw new ProjectCommandValidationError(`Stored Scenario command is invalid: ${change.type}`);
    }
    const parsed = ScenarioPlanCommandSchema.parse(storedExternalChange(change));
    return parseScenarioChanges([parsed])[0]!;
  });
}

function scenarioObject(value: ScenarioJson, label: string): Readonly<Record<string, ScenarioJson>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectCommandValidationError(`${label} is invalid`);
  }
  const result: Record<string, ScenarioJson> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = entry;
  return result;
}

function storedExternalChange(change: ScenarioPlanChange): unknown {
  if (change.type === "task.update") {
    const values = { ...scenarioObject(change.changes ?? null, "Stored task changes") };
    if (typeof values.budget === "number") {
      values.budgetMinor = String(values.budget);
      delete values.budget;
    }
    return { type: change.type, taskId: change.taskId, changes: values };
  }
  if (change.type === "task.add") {
    const task = { ...scenarioObject(change.task ?? null, "Stored Scenario task") };
    task.budgetMinor = String(task.budget);
    task.progressBasisPoints = typeof task.progressPercent === "number"
      ? Math.round(task.progressPercent * 100)
      : null;
    task.actualCostMinor = String(task.actualCost);
    delete task.budget;
    delete task.progressPercent;
    delete task.actualCost;
    return { type: change.type, task };
  }
  if (change.type === "resource.add") {
    const resource = { ...scenarioObject(change.resource ?? null, "Stored Scenario Resource") };
    resource.costRateMinorPerHour = String(resource.costRateMinorPerHour);
    return { type: change.type, resource };
  }
  if (change.type === "resource.update") {
    const values = { ...scenarioObject(change.changes ?? null, "Stored Resource changes") };
    if (typeof values.costRateMinorPerHour === "number") {
      values.costRateMinorPerHour = String(values.costRateMinorPerHour);
    }
    return { type: change.type, resourceId: change.resourceId, changes: values };
  }
  if (change.type === "assignment.replace") {
    return { type: change.type, taskId: change.taskId, assignments: change.assignments };
  }
  if (change.type === "task.delete") return { type: change.type, taskId: change.taskId };
  return { type: change.type, resourceId: change.resourceId };
}

function scenarioJson(value: unknown, path = "value"): ScenarioJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProjectCommandValidationError(`${path} is not JSON-safe`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => scenarioJson(entry, `${path}[${index}]`));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, ScenarioJson> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) result[key] = scenarioJson(entry, `${path}.${key}`);
    }
    return result;
  }
  throw new ProjectCommandValidationError(`${path} is not JSON-safe`);
}

function storedChanges(changes: readonly ScenarioPlanCommand[]): readonly ScenarioPlanChange[] {
  return changes.map((change) => {
    const value = scenarioJson(change, "Scenario change");
    return { ...scenarioObject(value, "Scenario change"), type: change.type };
  });
}

function canonicalJson(value: ScenarioJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ).map(
    ([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`,
  ).join(",")}}`;
}

async function sha256(value: ScenarioJson): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scenarioResponse(scenario: ProjectScenario) {
  return ScenarioResponseSchema.parse({
    id: scenario.id,
    name: scenario.name,
    status: scenario.status,
    baseProjectRevision: scenario.baseProjectRevision.toString(),
    revision: scenario.revision.toString(),
    changes: scenario.changes.map((change) => ({ ...change })),
    latestRun: scenario.latestRun === null ? null : {
      id: scenario.latestRun.id,
      sourceProjectRevision: scenario.latestRun.sourceProjectRevision.toString(),
      sourceScenarioRevision: scenario.latestRun.sourceScenarioRevision.toString(),
      algorithmVersion: scenario.latestRun.algorithmVersion,
      inputHash: scenario.latestRun.inputHash,
      output: scenario.latestRun.output,
      createdAt: scenario.latestRun.createdAt,
    },
    updatedAt: scenario.updatedAt,
    publishedAt: scenario.publishedAt,
    discardedAt: scenario.discardedAt,
  });
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

  for (const path of [
    "/api/tenants/:tenantId/projects/:projectId/scenarios",
    "/api/tenants/:tenantId/projects/:projectId/scenarios/*",
    "/api/tenants/:tenantId/projects/:projectId/staffing-proposals",
    "/api/tenants/:tenantId/projects/:projectId/staffing-proposals/*",
  ]) {
    app.use(path, bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) => context.json(
        { error: { code: "BODY_TOO_LARGE", message: "Request body exceeds 64 KiB" } },
        413,
      ),
    }));
    app.use(path, async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    });
  }

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

  app.openapi(staffingProposalListRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      await session.queryAuthorizer.authorize({ identity, tenantId, projectId });
      const proposals = await session.staffingProposals.list(tenantId, projectId);
      return context.json({ proposals: proposals.map(staffingProposalResponse) }, 200);
    } finally {
      await session.close();
    }
  });

  app.openapi(staffingProposalCreateRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const body = context.req.valid("json");
    const headers = context.req.valid("header");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      const result = await session.staffingSubmission.submit({
        identity,
        tenantId,
        projectId,
        ...body,
        idempotencyKey: headers["Idempotency-Key"],
      });
      return context.json({
        proposal: staffingProposalResponse(result.proposal),
        replayed: result.replayed,
      }, 202);
    } finally {
      await session.close();
    }
  });

  app.openapi(staffingProposalLoadRoute, async (context) => {
    const { tenantId, projectId, proposalId } = context.req.valid("param");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      await session.queryAuthorizer.authorize({ identity, tenantId, projectId });
      const proposal = await session.staffingProposals.load(tenantId, projectId, proposalId);
      if (proposal === null) throw new StaffingProposalNotFoundError(proposalId);
      return context.json(staffingProposalResponse(proposal), 200);
    } finally {
      await session.close();
    }
  });

  app.openapi(scenarioListRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      await session.queryAuthorizer.authorize({ identity, tenantId, projectId });
      const scenarios = await session.scenarios.list(tenantId, projectId);
      return context.json({ scenarios: scenarios.map(scenarioResponse) }, 200);
    } finally {
      await session.close();
    }
  });

  app.openapi(scenarioCreateRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const body = context.req.valid("json");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      const actor = await session.scenarioAuthorizer.authorize({ identity, tenantId, projectId });
      const workspace = await session.workspace.load(tenantId, projectId);
      if (workspace === null) throw new ProjectNotFoundError(projectId);
      const changes = parseScenarioChanges(body.changes);
      const created = await session.scenarios.create({
        tenantId, projectId, name: body.name, baseProjectRevision: workspace.revision,
        changes: storedChanges(changes), actor,
      });
      return context.json(scenarioResponse(created), 201);
    } finally {
      await session.close();
    }
  });

  app.openapi(scenarioLoadRoute, async (context) => {
    const { tenantId, projectId, scenarioId } = context.req.valid("param");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      await session.queryAuthorizer.authorize({ identity, tenantId, projectId });
      const scenario = await session.scenarios.load(tenantId, projectId, scenarioId);
      if (scenario === null) throw new ScenarioNotFoundError(scenarioId);
      return context.json(scenarioResponse(scenario), 200);
    } finally {
      await session.close();
    }
  });

  app.openapi(scenarioUpdateRoute, async (context) => {
    const { tenantId, projectId, scenarioId } = context.req.valid("param");
    const body = context.req.valid("json");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      const actor = await session.scenarioAuthorizer.authorize({ identity, tenantId, projectId });
      const changes = parseScenarioChanges(body.changes);
      const updated = await session.scenarios.updateChanges({
        tenantId, projectId, scenarioId, expectedRevision: BigInt(body.expectedRevision),
        changes: storedChanges(changes), actor,
      });
      return context.json(scenarioResponse(updated), 200);
    } finally {
      await session.close();
    }
  });

  app.openapi(scenarioRunRoute, async (context) => {
    const { tenantId, projectId, scenarioId } = context.req.valid("param");
    const body = context.req.valid("json");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      const actor = await session.scenarioAuthorizer.authorize({ identity, tenantId, projectId });
      const scenario = await session.scenarios.load(tenantId, projectId, scenarioId);
      const workspace = await session.workspace.load(tenantId, projectId);
      if (scenario === null) throw new ScenarioNotFoundError(scenarioId);
      if (scenario.status !== "DRAFT") throw new ScenarioTerminalError(scenario.status);
      const expectedRevision = BigInt(body.expectedRevision);
      if (scenario.revision !== expectedRevision) {
        throw new ScenarioRevisionConflictError(expectedRevision, scenario.revision);
      }
      if (workspace === null) throw new ProjectCommandValidationError("Scenario project was not found");
      if (workspace.baseline === null) throw new ProjectCommandValidationError("Scenario requires an approved Baseline");
      const changes = parseStoredScenarioChanges(scenario.changes);
      const snapshots = await session.performance.calculate(tenantId, projectId);
      const metrics = snapshots.at(-1)?.metrics;
      const trend = { spi: metrics?.spi ?? null, cpi: metrics?.cpi ?? null };
      const inputSnapshot = scenarioJson({
        algorithmVersion: SCENARIO_ALGORITHM_VERSION,
        projectRevision: workspace.revision.toString(),
        scenarioRevision: scenario.revision.toString(),
        current: projectStateResponse(workspace.current),
        baseline: projectStateResponse(workspace.baseline),
        changes,
        trend,
      }, "Scenario input");
      let calculation: ReturnType<typeof calculateScenario>;
      try {
        calculation = calculateScenario({
          current: workspace.current, baseline: workspace.baseline, changes, trend,
        });
      } catch (error) {
        throw new ProjectCommandValidationError(
          error instanceof Error ? error.message : "Scenario calculation failed",
        );
      }
      const output = scenarioJson(ScenarioResultSchema.parse(calculation), "Scenario output");
      await session.scenarios.saveRun({
        tenantId, projectId, scenarioId,
        expectedScenarioRevision: scenario.revision,
        sourceProjectRevision: workspace.revision,
        algorithmVersion: SCENARIO_ALGORITHM_VERSION,
        inputHash: await sha256(inputSnapshot), inputSnapshot, output, actor,
      });
      const saved = await session.scenarios.load(tenantId, projectId, scenarioId);
      if (saved === null) throw new ScenarioNotFoundError(scenarioId);
      return context.json(scenarioResponse(saved), 200);
    } finally {
      await session.close();
    }
  });

  app.openapi(scenarioDiscardRoute, async (context) => {
    const { tenantId, projectId, scenarioId } = context.req.valid("param");
    const body = context.req.valid("json");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      const actor = await session.scenarioAuthorizer.authorize({ identity, tenantId, projectId });
      const discarded = await session.scenarios.discard({
        tenantId, projectId, scenarioId, expectedRevision: BigInt(body.expectedRevision), actor,
      });
      return context.json(scenarioResponse(discarded), 200);
    } finally {
      await session.close();
    }
  });

  app.openapi(scenarioPublishRoute, async (context) => {
    const { tenantId, projectId, scenarioId } = context.req.valid("param");
    const headers = context.req.valid("header");
    const body = context.req.valid("json");
    const identity = await dependencies.authenticate(context.req.raw, context.env);
    const session = await dependencies.openProjectSession(context.env);
    try {
      const actor = await session.scenarioAuthorizer.authorize({ identity, tenantId, projectId });
      const scenario = await session.scenarios.load(tenantId, projectId, scenarioId);
      if (scenario === null) throw new ScenarioNotFoundError(scenarioId);
      if (scenario.status === "DISCARDED") throw new ScenarioTerminalError(scenario.status);
      if (scenario.status === "DRAFT" && scenario.latestRun === null) {
        throw new ScenarioRunRequiredError();
      }
      const changes = parseStoredScenarioChanges(scenario.changes);
      const result = await session.service.execute({
        tenantId, projectId, expectedRevision: BigInt(body.expectedProjectRevision),
        idempotencyKey: headers["Idempotency-Key"], actor,
        command: {
          type: "scenario.publish", scenarioId,
          scenarioRevision: body.expectedScenarioRevision,
          sourceProjectRevision: body.expectedProjectRevision,
          changes,
        },
      });
      try {
        await session.performance.refresh(tenantId, projectId);
      } catch (error) {
        console.error("Scenario published, but the derived performance cache could not be refreshed", error);
      }
      context.header("ETag", `"${result.revision}"`);
      return context.json({
        projectId: result.projectId, revision: result.revision.toString(), replayed: result.replayed,
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
