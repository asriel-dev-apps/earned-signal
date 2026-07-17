import {
  type AuthenticatedIdentity,
  type ProjectCommand,
} from "@earned-signal/application";
import { StaffingProposalNotFoundError } from "@earned-signal/persistence";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import {
  AssignmentSchema,
  RevisionSchema,
  ResourceChangesSchema,
  ResourceSchema,
  TaskChangesSchema,
  TaskSchema,
  UuidSchema,
  toCommand,
} from "./project-command-contract.js";
import type { ApiDependencies, ProjectSession } from "./api.js";
import { AuthenticationRequiredError } from "./oidc-auth.js";
import { errorName } from "./edge-security.js";
import { resolveProjectCommandError } from "./project-command-error.js";
import {
  StaffingProposalCreateSchema,
  StaffingProposalResponseSchema,
  staffingProposalResponse,
} from "./staffing-contract.js";

const MCP_SCOPES = [
  "project:progress:write",
  "project:actuals:write",
  "project:staffing:propose",
] as const;
const MAX_MCP_BODY_BYTES = 64 * 1024;

const ProjectCommandContextShape = {
  tenantId: UuidSchema.describe("Tenant that owns the project"),
  projectId: UuidSchema.describe("Project to change"),
  expectedRevision: RevisionSchema.describe("Current project revision as a decimal string"),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Stable unique key for safely retrying this command"),
};

const ProjectCommandOutputShape = {
  projectId: UuidSchema,
  revision: RevisionSchema,
  replayed: z.boolean(),
};

interface ProjectCommandContext {
  readonly tenantId: string;
  readonly projectId: string;
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
}

async function executeCommand(
  dependencies: ApiDependencies,
  environment: Env,
  identity: AuthenticatedIdentity,
  context: ProjectCommandContext,
  createCommand: () => ProjectCommand,
) {
  let session: ProjectSession | undefined;
  try {
    const command = createCommand();
    session = await dependencies.openProjectSession(environment);
    const actor = await session.authorizer.authorize({
      identity,
      tenantId: context.tenantId,
      projectId: context.projectId,
      command,
    });
    const result = await session.service.execute({
      tenantId: context.tenantId,
      projectId: context.projectId,
      expectedRevision: BigInt(context.expectedRevision),
      idempotencyKey: context.idempotencyKey,
      actor,
      command,
    });
    const output = {
      projectId: result.projectId,
      revision: result.revision.toString(),
      replayed: result.replayed,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    const resolution = resolveProjectCommandError(error);
    if (resolution === null) {
      console.error(
        JSON.stringify({
          event: "mcp_tool_unhandled_error",
          errorName: errorName(error),
        }),
      );
    }
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error:
              resolution?.error ?? {
                code: "INTERNAL_ERROR",
                message: "Internal server error",
              },
          }),
        },
      ],
    };
  } finally {
    await session?.close();
  }
}

function mcpToolError(error: unknown) {
  const resolution = resolveProjectCommandError(error);
  if (resolution === null) {
    console.error(JSON.stringify({
      event: "mcp_tool_unhandled_error",
      errorName: errorName(error),
    }));
  }
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({
      error: resolution?.error ?? { code: "INTERNAL_ERROR", message: "Internal server error" },
    }) }],
  };
}

async function requestStaffingProposal(
  dependencies: ApiDependencies,
  environment: Env,
  identity: AuthenticatedIdentity,
  input: z.infer<typeof StaffingProposalCreateSchema> & {
    readonly tenantId: string;
    readonly projectId: string;
    readonly idempotencyKey: string;
  },
) {
  let session: ProjectSession | undefined;
  try {
    const body = StaffingProposalCreateSchema.parse({
      name: input.name,
      expectedRevision: input.expectedRevision,
      remainingEffort: input.remainingEffort,
      candidateResources: input.candidateResources,
      constraints: input.constraints,
      objective: input.objective,
    });
    session = await dependencies.openProjectSession(environment);
    const result = await session.staffingSubmission.submit({
      identity,
      tenantId: input.tenantId,
      projectId: input.projectId,
      ...body,
      idempotencyKey: input.idempotencyKey,
    });
    const output = { proposal: staffingProposalResponse(result.proposal), replayed: result.replayed };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    return mcpToolError(error);
  } finally {
    await session?.close();
  }
}

async function readStaffingProposals(
  dependencies: ApiDependencies,
  environment: Env,
  identity: AuthenticatedIdentity,
  input: { readonly tenantId: string; readonly projectId: string; readonly proposalId?: string },
) {
  let session: ProjectSession | undefined;
  try {
    session = await dependencies.openProjectSession(environment);
    await session.queryAuthorizer.authorize({ identity, tenantId: input.tenantId, projectId: input.projectId });
    const output = input.proposalId === undefined
      ? { proposals: (await session.staffingProposals.list(input.tenantId, input.projectId)).map(staffingProposalResponse) }
      : staffingProposalResponse(
        (await session.staffingProposals.load(input.tenantId, input.projectId, input.proposalId))
          ?? (() => { throw new StaffingProposalNotFoundError(input.proposalId!); })(),
      );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    return mcpToolError(error);
  } finally {
    await session?.close();
  }
}

function createServer(
  dependencies: ApiDependencies,
  environment: Env,
  identity: AuthenticatedIdentity,
): McpServer {
  const server = new McpServer({ name: "EarnedSignal project commands", version: "0.1.0" });
  server.registerTool(
    "request_staffing_proposal",
    {
      description: "Request a constraint-based staffing proposal. The result remains a draft Scenario until a human publishes it.",
      annotations: { title: "Request staffing proposal", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        tenantId: UuidSchema,
        projectId: UuidSchema,
        idempotencyKey: z.string().trim().min(1).max(200),
        ...StaffingProposalCreateSchema.shape,
      },
    },
    async (input) => requestStaffingProposal(dependencies, environment, identity, input),
  );
  server.registerTool(
    "list_staffing_proposals",
    {
      description: "List staffing proposals for one project.",
      annotations: { title: "List staffing proposals", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { tenantId: UuidSchema, projectId: UuidSchema },
      outputSchema: { proposals: z.array(StaffingProposalResponseSchema) },
    },
    async (input) => readStaffingProposals(dependencies, environment, identity, input),
  );
  server.registerTool(
    "get_staffing_proposal",
    {
      description: "Get one staffing proposal, including its solver result and linked draft Scenario.",
      annotations: { title: "Get staffing proposal", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { tenantId: UuidSchema, projectId: UuidSchema, proposalId: UuidSchema },
      outputSchema: StaffingProposalResponseSchema.shape,
    },
    async (input) => readStaffingProposals(dependencies, environment, identity, input),
  );
  server.registerTool(
    "update_project_task",
    {
      description: "Update a project's task plan, progress, effort, or actual cost.",
      annotations: {
        title: "Update project task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        ...ProjectCommandContextShape,
        taskId: UuidSchema.describe("Task to update"),
        changes: TaskChangesSchema.describe("Only the task fields that should change"),
      },
      outputSchema: ProjectCommandOutputShape,
    },
    async ({ tenantId, projectId, expectedRevision, idempotencyKey, taskId, changes }) =>
      executeCommand(
        dependencies,
        environment,
        identity,
        { tenantId, projectId, expectedRevision, idempotencyKey },
        () => toCommand({ type: "task.update", taskId, changes }),
      ),
  );
  server.registerTool(
    "add_project_task",
    {
      description: "Add a leaf task to a project plan.",
      annotations: {
        title: "Add project task",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        ...ProjectCommandContextShape,
        task: TaskSchema.describe("Complete leaf task to add"),
      },
      outputSchema: ProjectCommandOutputShape,
    },
    async ({ tenantId, projectId, expectedRevision, idempotencyKey, task }) =>
      executeCommand(
        dependencies,
        environment,
        identity,
        { tenantId, projectId, expectedRevision, idempotencyKey },
        () => toCommand({ type: "task.add", task }),
      ),
  );
  server.registerTool(
    "delete_project_task",
    {
      description: "Delete a leaf task from a project plan.",
      annotations: {
        title: "Delete project task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        ...ProjectCommandContextShape,
        taskId: UuidSchema.describe("Task to delete"),
      },
      outputSchema: ProjectCommandOutputShape,
    },
    async ({ tenantId, projectId, expectedRevision, idempotencyKey, taskId }) =>
      executeCommand(
        dependencies,
        environment,
        identity,
        { tenantId, projectId, expectedRevision, idempotencyKey },
        () => toCommand({ type: "task.delete", taskId }),
      ),
  );
  server.registerTool(
    "add_project_resource",
    {
      description: "Add a resource with its capacity, rate, calendar, and skills.",
      annotations: {
        title: "Add project resource",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        ...ProjectCommandContextShape,
        resource: ResourceSchema.describe("Complete resource to add"),
      },
      outputSchema: ProjectCommandOutputShape,
    },
    async ({ tenantId, projectId, expectedRevision, idempotencyKey, resource }) =>
      executeCommand(
        dependencies,
        environment,
        identity,
        { tenantId, projectId, expectedRevision, idempotencyKey },
        () => toCommand({ type: "resource.add", resource }),
      ),
  );
  server.registerTool(
    "update_project_resource",
    {
      description: "Update a resource's capacity, rate, calendar, name, or skills.",
      annotations: {
        title: "Update project resource",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        ...ProjectCommandContextShape,
        resourceId: UuidSchema.describe("Resource to update"),
        changes: ResourceChangesSchema.describe("Only the resource fields that should change"),
      },
      outputSchema: ProjectCommandOutputShape,
    },
    async ({ tenantId, projectId, expectedRevision, idempotencyKey, resourceId, changes }) =>
      executeCommand(
        dependencies,
        environment,
        identity,
        { tenantId, projectId, expectedRevision, idempotencyKey },
        () => toCommand({ type: "resource.update", resourceId, changes }),
      ),
  );
  server.registerTool(
    "delete_project_resource",
    {
      description: "Delete an unassigned resource from a project.",
      annotations: {
        title: "Delete project resource",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        ...ProjectCommandContextShape,
        resourceId: UuidSchema.describe("Resource to delete"),
      },
      outputSchema: ProjectCommandOutputShape,
    },
    async ({ tenantId, projectId, expectedRevision, idempotencyKey, resourceId }) =>
      executeCommand(
        dependencies,
        environment,
        identity,
        { tenantId, projectId, expectedRevision, idempotencyKey },
        () => toCommand({ type: "resource.delete", resourceId }),
      ),
  );
  server.registerTool(
    "replace_task_assignments",
    {
      description: "Replace every resource assignment for one project task atomically.",
      annotations: {
        title: "Replace task assignments",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        ...ProjectCommandContextShape,
        taskId: UuidSchema.describe("Task whose assignments should be replaced"),
        assignments: z.array(AssignmentSchema).max(100),
      },
      outputSchema: ProjectCommandOutputShape,
    },
    async ({ tenantId, projectId, expectedRevision, idempotencyKey, taskId, assignments }) =>
      executeCommand(
        dependencies,
        environment,
        identity,
        { tenantId, projectId, expectedRevision, idempotencyKey },
        () => toCommand({ type: "assignment.replace", taskId, assignments }),
      ),
  );
  return server;
}

function validateResourceUrl(value: string): URL {
  const resource = new URL(value);
  const isLoopback = resource.hostname === "localhost" || resource.hostname === "127.0.0.1";
  if (
    (resource.protocol !== "https:" && !(resource.protocol === "http:" && isLoopback)) ||
    resource.search.length > 0 ||
    resource.hash.length > 0 ||
    resource.pathname === "/"
  ) {
    throw new Error("MCP resource URL is invalid");
  }
  return resource;
}

function metadataUrl(resource: URL): URL {
  const metadata = new URL(resource.origin);
  metadata.pathname = `/.well-known/oauth-protected-resource${resource.pathname}`;
  return metadata;
}

function mcpError(status: 403 | 413, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function boundedRequest(request: Request): Promise<Request | null> {
  if (request.body === null) return request;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !request.headers.has("transfer-encoding")) {
    const size = Number(contentLength);
    return Number.isInteger(size) && size >= 0 && size <= MAX_MCP_BODY_BYTES
      ? request
      : null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MCP_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}

export function createProjectMcpHandler(dependencies: ApiDependencies) {
  return async (
    request: Request,
    environment: Env,
    _context: ExecutionContext,
  ): Promise<Response | null> => {
    const resource = validateResourceUrl(environment.MCP_RESOURCE_URL);
    const metadata = metadataUrl(resource);
    const requestUrl = new URL(request.url);

    if (request.method === "GET" && requestUrl.pathname === metadata.pathname) {
      return Response.json(
        {
          resource: resource.href,
          authorization_servers: [environment.OIDC_ISSUER],
          scopes_supported: MCP_SCOPES,
          bearer_methods_supported: ["header"],
          resource_name: "EarnedSignal project commands",
        },
        { headers: { "Cache-Control": "public, max-age=300" } },
      );
    }
    if (requestUrl.pathname !== resource.pathname) return null;
    if (requestUrl.host !== resource.host) {
      return mcpError(403, "MCP request host is not permitted");
    }
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== resource.origin) {
      return mcpError(403, "MCP request origin is not permitted");
    }
    const bounded = await boundedRequest(request);
    if (bounded === null) {
      return mcpError(413, "MCP request body exceeds 64 KiB");
    }

    let identity;
    try {
      identity = await dependencies.authenticate(bounded, environment);
    } catch (error) {
      if (!(error instanceof AuthenticationRequiredError)) throw error;
      return Response.json(
        { error: "Authentication is required" },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
            "WWW-Authenticate": `Bearer resource_metadata="${metadata.href}"`,
          },
        },
      );
    }

    const server = createServer(dependencies, environment, identity);
    const response = await createMcpHandler(server, {
      route: resource.pathname,
      enableJsonResponse: true,
      authContext: { props: { identity } },
    })(bounded, environment, _context);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  };
}
