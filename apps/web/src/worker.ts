import {
  createProjectCommandAuthorizer,
  createProjectCommandService,
} from "@earned-signal/application";
import {
  createPersistenceDatabase,
  PostgresProjectAccessGrantResolver,
  PostgresProjectCommandUnitOfWork,
} from "@earned-signal/persistence";
import { Client } from "pg";
import { createApiApp, type ProjectCommandSession } from "./api.js";
import {
  createJoseOidcTokenVerifier,
  createOidcBearerAuthenticator,
} from "./oidc-auth.js";

export async function openHyperdriveCommandSession(
  environment: Env,
): Promise<ProjectCommandSession> {
  const client = new Client({ connectionString: environment.HYPERDRIVE.connectionString });
  await client.connect();
  const database = createPersistenceDatabase(client);
  return {
    service: createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(database),
    ),
    authorizer: createProjectCommandAuthorizer(
      new PostgresProjectAccessGrantResolver(database),
    ),
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
  openCommandSession: openHyperdriveCommandSession,
});

export default app;
