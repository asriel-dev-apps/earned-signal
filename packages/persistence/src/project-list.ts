import type { ProjectRole } from "@vecta/application";
import { and, asc, eq } from "drizzle-orm";
import type { PersistenceDatabase } from "./persistence-database.js";
import { projectMemberships, projects } from "./schema.js";

/**
 * One accessible project for a principal: the project identity + the principal's
 * role on it. The web SSR loader and the later Hono `/api`+`/mcp` surfaces
 * (ADR 0012 §Decision 3) share this reader, so it lives in persistence rather
 * than in any one app.
 */
export interface AccessibleProject {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly role: ProjectRole;
}

/**
 * Principal-keyed project list. A single `project_memberships ⨝ projects` join
 * filtered by `principalId` — the composite FK
 * (`project_memberships_tenant_membership_fk`) already guarantees the matching
 * tenant membership, so no third join to `tenant_memberships` is needed. Sorted
 * by name (then id, since names are not unique) so the result is deterministic.
 */
export class PostgresProjectListReader {
  constructor(private readonly database: PersistenceDatabase) {}

  async listForPrincipal(
    principalId: string,
  ): Promise<readonly AccessibleProject[]> {
    return this.database
      .select({
        id: projects.id,
        tenantId: projects.tenantId,
        name: projects.name,
        role: projectMemberships.role,
      })
      .from(projectMemberships)
      .innerJoin(
        projects,
        and(
          eq(projects.tenantId, projectMemberships.tenantId),
          eq(projects.id, projectMemberships.projectId),
        ),
      )
      .where(eq(projectMemberships.principalId, principalId))
      .orderBy(asc(projects.name), asc(projects.id));
  }
}
