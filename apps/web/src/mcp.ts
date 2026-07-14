import type { AuthenticatedIdentity, ProjectCommand } from "@earned-signal/application";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import {
  RevisionSchema,
  TaskChangesSchema,
  TaskSchema,
  UuidSchema,
  toCommand,
} from "./project-command-contract.js";
import type { ApiDependencies, ProjectCommandSession } from "./api.js";
import { AuthenticationRequiredError } from "./oidc-auth.js";
import { resolveProjectCommandError } from "./project-command-error.js";

const MCP_SCOPES = ["project:progress:write", "project:actuals:write"] as const;
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
  let session: ProjectCommandSession | undefined;
  try {
    const command = createCommand();
    session = await dependencies.openCommandSession(environment);
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
          message: "Unhandled MCP tool error",
          error: error instanceof Error ? error.message : String(error),
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

function createServer(
  dependencies: ApiDependencies,
  environment: Env,
  identity: AuthenticatedIdentity,
): McpServer {
  const server = new McpServer({ name: "EarnedSignal project commands", version: "0.1.0" });
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
