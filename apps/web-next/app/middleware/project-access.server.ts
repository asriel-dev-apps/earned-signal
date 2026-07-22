import { data, type MiddlewareFunction } from "react-router";
import { findProjectMembership } from "~/server/auth/principal-directory";
import { requirePrincipal } from "~/server/auth/require-principal";
import { appContext, projectAccessContext } from "~/server/context";
import {
  isProjectId,
  type ProjectReader,
  type ResolvedProjectAccess,
} from "~/server/project/project-access";
import { projectReaderFromEnv } from "~/server/project/project-reader.neon.server";

/**
 * The `/projects/:id` access gate (ADR 0012 §Decision 2), enforced as MIDDLEWARE
 * so the denial `throw` happens BEFORE `next()` — no child loader ever runs for a
 * request the principal may not see (the security property a parent loader could
 * not provide). It:
 *   1. rejects a non-UUID `:id` before any principal load or DB round trip;
 *   2. awaits the memoised principal (which carries its project memberships);
 *   3. finds the membership via the shared pure {@link findProjectMembership};
 *   4. throws an identical `404` for a non-member OR a nonexistent project — the
 *      two are indistinguishable by design — and only then, on success, installs
 *      a lazily-memoised project-row loader on the context.
 *
 * VIEWER passes the gate (read access); denial means *no membership*.
 * Write-authorization is the Step-4 command authorizer, not this gate. The
 * cookie session uses this in-memory check rather than
 * `PostgresProjectAccessGrantResolver` (the token-identity seam for Step 5's
 * Hono surface): it is exact-equivalent here and costs zero extra round trips.
 *
 * `readerFor` is injectable so tests can supply a fake project reader; production
 * defaults to the Neon-backed one built from `env`.
 */
export interface ProjectAccessMiddlewareOptions {
  readonly readerFor?: (env: Env) => ProjectReader;
}

export function createProjectAccessMiddleware(
  options: ProjectAccessMiddlewareOptions = {},
): MiddlewareFunction<Response> {
  const readerFor = options.readerFor ?? projectReaderFromEnv;
  return async ({ context, params }) => {
    const projectId = params.id;
    if (!isProjectId(projectId)) {
      throw data(null, { status: 404 });
    }
    const principal = await requirePrincipal(context);
    const membership = findProjectMembership(principal, projectId);
    if (membership === null) {
      throw data(null, { status: 404 });
    }
    const tenantRole = principal.tenantMemberships.find(
      (tenant) => tenant.tenantId === membership.tenantId,
    )?.role;
    const { env } = context.get(appContext);
    const reader = readerFor(env);
    // Access granted. Install the memoised project-row thunk; it issues no query
    // until a loader/component first calls `requireProjectAccess`, then caches it
    // so parallel loaders share one round trip. The deny paths above never reach
    // here, so a denied request touches no project database.
    let cached: Promise<ResolvedProjectAccess> | undefined;
    context.set(
      projectAccessContext,
      () =>
        (cached ??= reader
          .loadProject(membership.tenantId, projectId)
          .then((project): ResolvedProjectAccess => {
            if (project === null) {
              // Membership exists but the project row is gone: fail closed.
              throw data(null, { status: 404 });
            }
            return {
              project,
              membership: {
                tenantId: membership.tenantId,
                projectId: membership.projectId,
                projectRole: membership.role,
                ...(tenantRole !== undefined ? { tenantRole } : {}),
              },
            };
          })),
    );
  };
}
