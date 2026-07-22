import { createContext } from "react-router";
import type { AuthenticatedPrincipal } from "./auth/principal-directory";

/**
 * Router context handles shared between the Worker entry (`workers/app.ts`,
 * which seeds them via `getLoadContext`) and the route modules that read them
 * in loaders/actions/middleware. This is the documented React Router v8 pattern
 * for bridging the adapter's `env`/`ctx` into the request lifecycle.
 */

/** The Worker bindings + execution context for the current request. */
export const appContext = createContext<{
  readonly env: Env;
  readonly ctx: ExecutionContext;
}>();

/**
 * A memoised, per-request loader for the authenticated principal. The auth
 * middleware installs it after verifying the session cookie; calling it more
 * than once (e.g. from several loaders batched by RR single fetch) hits the DB
 * only once. Present only on the protected subtree.
 */
export const principalContext =
  createContext<() => Promise<AuthenticatedPrincipal | null>>();
