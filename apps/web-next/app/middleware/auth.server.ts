import { redirect, type MiddlewareFunction } from "react-router";
import { appContext, principalContext } from "~/server/context";
import type {
  AuthenticatedPrincipal,
  PrincipalDirectory,
} from "~/server/auth/principal-directory";
import { principalDirectoryFromEnv } from "~/server/auth/principal-directory.neon.server";
import { safeReturnTo } from "~/server/auth/redirect";
import { readSession } from "~/server/auth/session.server";

/**
 * Authentication middleware for the protected route subtree (ADR 0012
 * §Decision 4/5). It runs before any loader on that subtree and:
 *   1. verifies the signed session cookie — pure crypto, NO database — and
 *      rejects an absent/tampered/expired session by redirecting to `/login`
 *      with the current path as `returnTo` (fail-closed);
 *   2. otherwise installs a memoised principal loader on the router context so
 *      the DB is hit at most once per request, no matter how many loaders call
 *      `requirePrincipal` (RR single fetch runs them in parallel).
 *
 * Roles are resolved lazily from the DB, never cached in the cookie, and only
 * for this protected subtree — public routes (`/login`, `/auth/callback`,
 * `/logout`) live outside it and never trigger a lookup.
 *
 * `directoryFor` is injectable so tests can supply a fake directory; production
 * defaults to the Neon-backed one built from `env`.
 */
export interface AuthMiddlewareOptions {
  readonly directoryFor?: (env: Env) => PrincipalDirectory;
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareFunction<Response> {
  const directoryFor = options.directoryFor ?? principalDirectoryFromEnv;
  return async ({ request, context }) => {
    const { env } = context.get(appContext);
    const session = await readSession(env, request);
    if (session === null) {
      const url = new URL(request.url);
      const returnTo = safeReturnTo(url.pathname + url.search);
      throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    const directory = directoryFor(env);
    let cached: Promise<AuthenticatedPrincipal | null> | undefined;
    context.set(
      principalContext,
      () => (cached ??= directory.loadPrincipal(session.principalId)),
    );
  };
}
