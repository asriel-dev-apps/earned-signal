import {
  openNeonPersistenceConnection,
  principals,
  projectMemberships,
  tenantMemberships,
  type PersistenceDatabase,
} from "@vecta/persistence";
import { and, eq, isNull } from "drizzle-orm";
import type {
  AuthenticatedPrincipal,
  PrincipalDirectory,
  PrincipalIdentity,
} from "./principal-directory";

/**
 * Neon-backed {@link PrincipalDirectory}. Persistence uses a serverless driver
 * (each query is a network round trip), so `loadPrincipal` runs the two
 * membership lookups in parallel after the principal row, and each public
 * method opens/closes a single connection for its (at most once-per-request)
 * call.
 */
export function createNeonPrincipalDirectory(
  databaseUrl: string,
): PrincipalDirectory {
  async function withDatabase<T>(
    run: (database: PersistenceDatabase) => Promise<T>,
  ): Promise<T> {
    const connection = openNeonPersistenceConnection(databaseUrl);
    try {
      return await run(connection.database);
    } finally {
      // Never let a close failure mask the original query error.
      await connection.close().catch(() => undefined);
    }
  }

  return {
    async findByIssuerSubject(issuer, subject) {
      return withDatabase(async (database) => {
        const [row] = await database
          .select({
            id: principals.id,
            issuer: principals.issuer,
            subject: principals.subject,
            displayName: principals.displayName,
            type: principals.type,
          })
          .from(principals)
          .where(
            and(
              eq(principals.issuer, issuer),
              eq(principals.subject, subject),
              isNull(principals.disabledAt),
            ),
          )
          .limit(1);
        return row ?? null;
      });
    },

    async loadPrincipal(principalId) {
      return withDatabase(async (database) => {
        const [principal] = await database
          .select({
            id: principals.id,
            issuer: principals.issuer,
            subject: principals.subject,
            displayName: principals.displayName,
            type: principals.type,
          })
          .from(principals)
          .where(
            and(eq(principals.id, principalId), isNull(principals.disabledAt)),
          )
          .limit(1);
        if (principal === undefined) {
          return null;
        }
        const [tenants, projects] = await Promise.all([
          database
            .select({
              tenantId: tenantMemberships.tenantId,
              role: tenantMemberships.role,
            })
            .from(tenantMemberships)
            .where(eq(tenantMemberships.principalId, principalId)),
          database
            .select({
              tenantId: projectMemberships.tenantId,
              projectId: projectMemberships.projectId,
              role: projectMemberships.role,
            })
            .from(projectMemberships)
            .where(eq(projectMemberships.principalId, principalId)),
        ]);
        const resolved: AuthenticatedPrincipal = {
          principal: principal satisfies PrincipalIdentity,
          tenantMemberships: tenants,
          projectMemberships: projects,
        };
        return resolved;
      });
    },
  };
}

/** Resolve the directory from the Worker environment (`DATABASE_URL` secret). */
export function principalDirectoryFromEnv(env: Env): PrincipalDirectory {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not configured for principal resolution");
  }
  return createNeonPrincipalDirectory(databaseUrl);
}
