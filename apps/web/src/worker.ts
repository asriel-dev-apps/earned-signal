import {
  createProjectCommandAuthorizer,
  createProjectCommandService,
  createProjectQueryAuthorizer,
} from "@earned-signal/application";
import {
  createPersistenceDatabase,
  PostgresProjectAccessGrantResolver,
  PostgresProjectCommandUnitOfWork,
  ProjectWorkspaceRepository,
} from "@earned-signal/persistence";
import { Client } from "pg";
import { createApiApp, type ProjectSession } from "./api.js";
import {
  createJoseOidcTokenVerifier,
  createOidcBearerAuthenticator,
} from "./oidc-auth.js";
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
  return {
    service: createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(database),
    ),
    authorizer: createProjectCommandAuthorizer(grantResolver),
    queryAuthorizer: createProjectQueryAuthorizer(grantResolver),
    workspace: new ProjectWorkspaceRepository(database),
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
    await enforceAuthenticatedLimits(environment.AUTH_RATE_LIMIT, request, identity);
    return identity;
  };

const app = createApiApp({
  authenticate: authenticateForAudience((environment) => environment.OIDC_AUDIENCE),
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
        if (pathname.startsWith("/api/") || pathname.startsWith("/.well-known/")) {
          response = await app.fetch(correlated, environment, context);
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
