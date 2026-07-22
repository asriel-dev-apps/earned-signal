import {
  principals,
  projectMemberships,
  tenantMemberships,
} from "@vecta/persistence";
import { and, eq, isNull } from "drizzle-orm";
import type { DbSession } from "../db-session.server";
import type {
  AuthenticatedPrincipal,
  PrincipalDirectory,
  PrincipalIdentity,
} from "./principal-directory";

/**
 * Neon-backed {@link PrincipalDirectory} built over the per-request
 * {@link DbSession} (ADR 0012 §4-pre). Persistence uses a serverless driver
 * (each query is a network round trip), so `loadPrincipal` runs the two
 * membership lookups in parallel after the principal row. Each method reads the
 * shared connection via `session.database()` (opened lazily on first use,
 * memoised for the rest of the request) and NEVER closes it: the root middleware
 * owns the session lifecycle.
 */
export function createNeonPrincipalDirectory(
  session: DbSession,
): PrincipalDirectory {
  return {
    async findByIssuerSubject(issuer, subject) {
      const database = session.database();
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
    },

    async loadPrincipal(principalId) {
      const database = session.database();
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
    },
  };
}
