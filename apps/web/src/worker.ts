import {
  createProjectCommandAuthorizer,
  createProjectCommandService,
  createProjectQueryAuthorizer,
  createScenarioMutationAuthorizer,
  createStaffingProposalAuthorizer,
  createStaffingProposalSubmissionService,
} from "@earned-signal/application";
import {
  createPersistenceDatabase,
  PostgresProjectAccessGrantResolver,
  PostgresProjectCommandUnitOfWork,
  ProjectPerformanceRepository,
  ProjectForecastRunRepository,
  ProjectScenarioRepository,
  ProjectStaffingProposalRepository,
  ProjectWorkspaceRepository,
  type StaffingProposalJson,
} from "@earned-signal/persistence";
import { Client } from "pg";
import { createApiApp, type ProjectSession } from "./api.js";
import { createProjectMcpHandler } from "./mcp.js";
import {
  createJoseOidcTokenVerifier,
  createOidcBearerAuthenticator,
} from "./oidc-auth.js";
import { ensureStaffingWorkflow } from "./workflow-dispatch.js";
import { staffingProposalHash } from "./staffing-contract.js";
import {
  bodyTooLargeResponse,
  boundedRequest,
  enforceAuthenticatedLimits,
  enforcePreAuthenticationLimit,
  internalErrorResponse,
  rateLimitedResponse,
  requestId,
  RequestRateLimitedError,
  routeKey,
  secureResponse,
  withRequestId,
  writeHttpRequestLog,
} from "./edge-security.js";

export async function openHyperdriveProjectSession(
  environment: Env,
): Promise<ProjectSession> {
  const client = new Client({ connectionString: environment.HYPERDRIVE.connectionString });
  await client.connect();
  const database = createPersistenceDatabase(client);
  const grantResolver = new PostgresProjectAccessGrantResolver(database);
  const staffingProposals = new ProjectStaffingProposalRepository(database);
  const workspace = new ProjectWorkspaceRepository(database);
  return {
    service: createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(database),
    ),
    authorizer: createProjectCommandAuthorizer(grantResolver),
    queryAuthorizer: createProjectQueryAuthorizer(grantResolver),
    scenarioAuthorizer: createScenarioMutationAuthorizer(grantResolver),
    staffingSubmission: createStaffingProposalSubmissionService({
      authorizer: createStaffingProposalAuthorizer(grantResolver),
      workspace,
      proposals: {
        create: (request) => staffingProposals.create({
          ...request,
          input: request.input as unknown as StaffingProposalJson,
        }),
      },
      requestHasher: { hash: staffingProposalHash },
      dispatch: (request) => ensureStaffingWorkflow(environment.STAFFING_WORKFLOW, request),
    }),
    scenarios: new ProjectScenarioRepository(database),
    staffingProposals,
    forecastRuns: new ProjectForecastRunRepository(database),
    performance: new ProjectPerformanceRepository(database),
    workspace,
    // Hyperdrive owns the origin pool; the invocation-scoped client is not ended in Workers.
    close: async () => undefined,
  };
}

const authenticator = createOidcBearerAuthenticator(createJoseOidcTokenVerifier());
const authenticateForAudience = (audience: (environment: Env) => string) =>
  async (request: Request, environment: Env) => {
    const identity = await authenticator.authenticate(request, {
      issuer: environment.OIDC_ISSUER,
      audience: audience(environment),
      jwksUrl: environment.OIDC_JWKS_URL,
    });
    await enforceAuthenticatedLimits(
      environment.AUTH_RATE_LIMIT,
      environment.COMPUTE_RATE_LIMIT,
      request,
      identity,
    );
    return identity;
  };

const app = createApiApp({
  authenticate: authenticateForAudience((environment) => environment.OIDC_AUDIENCE),
  openProjectSession: openHyperdriveProjectSession,
});

const mcp = createProjectMcpHandler({
  authenticate: authenticateForAudience((environment) => environment.MCP_RESOURCE_URL),
  openProjectSession: openHyperdriveProjectSession,
});

export default {
  async fetch(request, environment, context) {
    const id = requestId();
    const startedAt = Date.now();
    const route = routeKey(request);
    let response: Response;
    let failure: unknown;
    try {
      await enforcePreAuthenticationLimit(environment.PRE_AUTH_RATE_LIMIT, request);
      const bounded = await boundedRequest(request);
      if (bounded === null) {
        response = bodyTooLargeResponse();
      } else {
        const correlated = withRequestId(bounded, id);
        const pathname = new URL(correlated.url).pathname;
        if (pathname.startsWith("/api/") || pathname.startsWith("/.well-known/") || pathname === "/mcp") {
          const mcpResponse = await mcp(correlated, environment, context);
          response = mcpResponse ?? await app.fetch(correlated, environment, context);
        } else {
          response = await environment.ASSETS.fetch(correlated);
        }
      }
    } catch (error) {
      failure = error;
      response = error instanceof RequestRateLimitedError
        ? rateLimitedResponse()
        : internalErrorResponse();
    }
    const secured = secureResponse(request, response, id, environment.OIDC_ISSUER);
    writeHttpRequestLog({
      requestId: id,
      method: request.method,
      route,
      status: secured.status,
      durationMs: Date.now() - startedAt,
      ...(failure === undefined ? {} : { error: failure }),
    });
    return secured;
  },
} satisfies ExportedHandler<Env>;
