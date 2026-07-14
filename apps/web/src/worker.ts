import { createProjectCommandService } from "@earned-signal/application";
import {
  createPersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
} from "@earned-signal/persistence";
import { Client } from "pg";
import {
  AuthenticationRequiredError,
  createApiApp,
  type ProjectCommandSession,
} from "./api.js";

export async function openHyperdriveCommandSession(
  environment: Env,
): Promise<ProjectCommandSession> {
  const client = new Client({ connectionString: environment.HYPERDRIVE.connectionString });
  await client.connect();
  return {
    service: createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    ),
    // Hyperdrive owns the origin pool; the invocation-scoped client is not ended in Workers.
    close: async () => undefined,
  };
}

const app = createApiApp({
  resolveActor: async () => {
    throw new AuthenticationRequiredError();
  },
  openCommandSession: openHyperdriveCommandSession,
});

export default app;
