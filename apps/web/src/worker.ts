import { createProjectCommandService } from "@earned-signal/application";
import {
  createPersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
} from "@earned-signal/persistence";
import { Client } from "pg";
import { AuthenticationRequiredError, createApiApp } from "./api.js";

const app = createApiApp({
  resolveActor: async () => {
    throw new AuthenticationRequiredError();
  },
  openCommandSession: async (environment) => {
    const client = new Client({ connectionString: environment.HYPERDRIVE.connectionString });
    await client.connect();
    return {
      service: createProjectCommandService(
        new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
      ),
      // Hyperdrive owns the origin pool; the invocation-scoped client is not ended in Workers.
      close: async () => undefined,
    };
  },
});

export default app;
