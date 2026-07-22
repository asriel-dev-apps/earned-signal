import { projects } from "@vecta/persistence";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "../db-session.server";
import type { ProjectReader } from "./project-access";

/**
 * Neon-backed {@link ProjectReader} built over the per-request {@link DbSession}
 * (ADR 0012 §4-pre). Fetches the project row by its composite `(tenantId, id)`
 * key — never by global id alone — so the row is read through the same tenant
 * scope the membership was matched on. Reads the shared connection via
 * `session.database()` (opened lazily, memoised for the request) and NEVER
 * closes it: the root middleware owns the session lifecycle.
 */
export function createNeonProjectReader(session: DbSession): ProjectReader {
  return {
    async loadProject(tenantId, projectId) {
      const database = session.database();
      const [row] = await database
        .select({
          id: projects.id,
          tenantId: projects.tenantId,
          name: projects.name,
        })
        .from(projects)
        .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
        .limit(1);
      return row ?? null;
    },
  };
}
