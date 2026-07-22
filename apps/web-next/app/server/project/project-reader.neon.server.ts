import { openNeonPersistenceConnection, projects } from "@vecta/persistence";
import { and, eq } from "drizzle-orm";
import type { ProjectReader } from "./project-access";

/**
 * Neon-backed {@link ProjectReader}. Fetches the project row by its composite
 * `(tenantId, id)` key — never by global id alone — so the row is read through
 * the same tenant scope the membership was matched on. Opens/closes one
 * connection per (at most once-per-request) call, like the principal directory.
 */
export function createNeonProjectReader(databaseUrl: string): ProjectReader {
  return {
    async loadProject(tenantId, projectId) {
      const connection = openNeonPersistenceConnection(databaseUrl);
      try {
        const [row] = await connection.database
          .select({
            id: projects.id,
            tenantId: projects.tenantId,
            name: projects.name,
          })
          .from(projects)
          .where(
            and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)),
          )
          .limit(1);
        return row ?? null;
      } finally {
        // Never let a close failure mask the original query error.
        await connection.close().catch(() => undefined);
      }
    },
  };
}

/** Resolve the reader from the Worker environment (`DATABASE_URL` secret). */
export function projectReaderFromEnv(env: Env): ProjectReader {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not configured for project resolution");
  }
  return createNeonProjectReader(databaseUrl);
}
