import type { AuthenticatedIdentity } from "@vecta/application";
import {
  PostgresProjectAccessGrantResolver,
  PostgresProjectListReader,
  ProjectWorkspaceRepository,
} from "@vecta/persistence";
import { createDbSession } from "../db-session.server";
import { createApiApp, type ApiPersistence } from "./app";
import {
  boundedRequest,
  bodyTooLargeResponse,
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
} from "./edge-security";
import {
  createJoseOidcTokenVerifier,
  createOidcBearerAuthenticator,
} from "./oidc-auth";

/**
 * Production wiring + edge-security wrapper for the `/api` surface (ADR 0012
 * Step 5a). The Worker entry dispatches `/api*` here; everything below is the
 * real Neon-backed composition of the injectable app in `./app`.
 */

const neonApiPersistence: ApiPersistence = {
  grantResolver: (session) => new PostgresProjectAccessGrantResolver(session.database()),
  workspace: (session) => new ProjectWorkspaceRepository(session.database()),
  listReader: (session) => new PostgresProjectListReader(session.database()),
};

const authenticator = createOidcBearerAuthenticator(createJoseOidcTokenVerifier());

// The `/api` audience is OIDC_CLIENT_ID (ADR 0012 §Decision 4 / Step 5 plan — no
// new var). The authed rate limit is enforced only after a token verifies, so an
// unauthenticated flood is bounded by the pre-auth (IP) limiter instead.
async function authenticateApiRequest(
  request: Request,
  environment: Env,
): Promise<AuthenticatedIdentity> {
  const identity = await authenticator.authenticate(request, {
    issuer: environment.OIDC_ISSUER,
    audience: environment.OIDC_CLIENT_ID,
    jwksUrl: environment.OIDC_JWKS_URL,
  });
  await enforceAuthenticatedLimits(environment.AUTH_RATE_LIMIT, request, identity);
  return identity;
}

const apiApp = createApiApp({
  authenticate: authenticateApiRequest,
  createSession: (environment) => createDbSession(environment),
  persistence: neonApiPersistence,
});

/**
 * Handle a `/api*` request with the full edge-security posture: a pre-auth
 * (IP+route) rate limit, a 64 KiB bounded body, a request-id + JSON request log,
 * and `secureResponse` headers (`no-store`, deny-all CSP). Mirrors the old
 * `apps/web` worker's `fetch`, scoped to the Hono branch.
 */
export async function handleApiRequest(
  request: Request,
  environment: Env,
  context: ExecutionContext,
): Promise<Response> {
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
      response = await apiApp.fetch(correlated, environment, context);
    }
  } catch (error) {
    failure = error;
    response =
      error instanceof RequestRateLimitedError ? rateLimitedResponse() : internalErrorResponse();
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
}
