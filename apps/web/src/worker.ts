import {
  createProjectCommandAuthorizer,
  createProjectCommandService,
  createProjectQueryAuthorizer,
} from "@earned-signal/application";
import {
  createPersistenceDatabase,
  PostgresProjectAccessGrantResolver,
  PostgresProjectCommandUnitOfWork,
  ProjectPerformanceRepository,
  ProjectWorkspaceRepository,
} from "@earned-signal/persistence";
import { Client } from "pg";
import { createApiApp, type ProjectSession } from "./api.js";
import { createProjectMcpHandler } from "./mcp.js";
import {
  createJoseOidcTokenVerifier,
  createOidcBearerAuthenticator,
} from "./oidc-auth.js";

export async function openHyperdriveProjectSession(
  environment: Env,
): Promise<ProjectSession> {
  const client = new Client({ connectionString: environment.HYPERDRIVE.connectionString });
  await client.connect();
  const database = createPersistenceDatabase(client);
  const grantResolver = new PostgresProjectAccessGrantResolver(database);
  return {
    service: createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(database),
    ),
    authorizer: createProjectCommandAuthorizer(grantResolver),
    queryAuthorizer: createProjectQueryAuthorizer(grantResolver),
    performance: new ProjectPerformanceRepository(database),
    workspace: new ProjectWorkspaceRepository(database),
    // Hyperdrive owns the origin pool; the invocation-scoped client is not ended in Workers.
    close: async () => undefined,
  };
}

const authenticator = createOidcBearerAuthenticator(createJoseOidcTokenVerifier());
const app = createApiApp({
  authenticate: (request, environment) =>
    authenticator.authenticate(request, {
      issuer: environment.OIDC_ISSUER,
      audience: environment.OIDC_AUDIENCE,
      jwksUrl: environment.OIDC_JWKS_URL,
    }),
  openProjectSession: openHyperdriveProjectSession,
});

const mcp = createProjectMcpHandler({
  authenticate: (request, environment) =>
    authenticator.authenticate(request, {
      issuer: environment.OIDC_ISSUER,
      audience: environment.MCP_RESOURCE_URL,
      jwksUrl: environment.OIDC_JWKS_URL,
    }),
  openProjectSession: openHyperdriveProjectSession,
});

export default {
  async fetch(request, environment, context) {
    const mcpResponse = await mcp(request, environment, context);
    return mcpResponse ?? app.fetch(request, environment, context);
  },
} satisfies ExportedHandler<Env>;
