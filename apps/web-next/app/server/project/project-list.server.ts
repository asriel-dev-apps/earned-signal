import {
  openNeonPersistenceConnection,
  PostgresProjectListReader,
  type AccessibleProject,
} from "@vecta/persistence";
import type { RouterContextProvider } from "react-router";
import { requirePrincipal } from "../auth/require-principal";
import { appContext } from "../context";

/**
 * A short-lived source of the current principal's accessible projects: the
 * persistence reader plus the connection that owns it. `close()` releases the
 * connection when the loader finishes. Injectable so the `/projects` loader test
 * can supply a fake list without a database.
 */
export interface ProjectListSource {
  listForPrincipal(
    principalId: string,
  ): Promise<readonly AccessibleProject[]>;
  close(): Promise<void>;
}

/** Open a Neon-backed list source (reused by the later Hono surface via persistence). */
export function projectListSourceFromEnv(env: Env): ProjectListSource {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not configured for the project list");
  }
  const connection = openNeonPersistenceConnection(databaseUrl);
  const reader = new PostgresProjectListReader(connection.database);
  return {
    listForPrincipal: (principalId) => reader.listForPrincipal(principalId),
    close: () => connection.close(),
  };
}

export interface ProjectListData {
  readonly projects: readonly AccessibleProject[];
}

export interface LoadProjectListOptions {
  readonly sourceFor?: (env: Env) => ProjectListSource;
}

/**
 * Load the signed-in principal's accessible projects for the `/projects` list.
 * The principal is the memoised one from the auth middleware; the list is read
 * over a single connection that is always closed. `sourceFor` is injectable for
 * tests; production opens a Neon connection.
 */
export async function loadProjectList(
  context: Readonly<RouterContextProvider>,
  options: LoadProjectListOptions = {},
): Promise<ProjectListData> {
  const principal = await requirePrincipal(context);
  const sourceFor = options.sourceFor ?? projectListSourceFromEnv;
  const { env } = context.get(appContext);
  const source = sourceFor(env);
  try {
    const projects = await source.listForPrincipal(principal.principal.id);
    return { projects };
  } finally {
    await source.close();
  }
}
