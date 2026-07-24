import {
  createRequestHandler,
  RouterContextProvider,
  type ServerBuild,
} from "react-router";
import { appContext } from "../app/server/context";
import { handleApiRequest } from "../app/server/api";

const reactRouterHandler = createRequestHandler(
  // React Router's generated virtual-build exports type each optional field as
  // `T | undefined`, which the repo's `exactOptionalPropertyTypes` rejects
  // against `ServerBuild`'s `field?: T`. The runtime shape is correct, so bridge
  // the generated type to `ServerBuild` explicitly.
  () =>
    import("virtual:react-router/server-build") as unknown as Promise<ServerBuild>,
  import.meta.env.MODE,
);

// External API + MCP surface (ADR 0012 §Decision 3). `/api` (the token-auth
// zod-openapi surface) is live as of Step 5a; `/mcp` lands in Step 5b. Both are
// cookie-session-free by construction: they are dispatched here and never reach
// the React Router auth middleware.

/** Exact-or-subpath match so `/apifoo` falls through to React Router, not `/api`. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** Exact-or-subpath match so `/mcpfoo` falls through to React Router, not `/mcp`. */
export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function mcpNotImplemented(): Response {
  // Step 5b skeleton — the stateless remote MCP server ports here next.
  return Response.json(
    { error: "mcp not implemented (ADR 0012 step 5b)" },
    { status: 501 },
  );
}

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (isApiPath(pathname)) {
      return handleApiRequest(request, env, ctx);
    }
    if (isMcpPath(pathname)) {
      return mcpNotImplemented();
    }
    // React Router v8 requires the load context to be a `RouterContextProvider`
    // (a plain object no longer type-checks or works). Seed it with the Worker
    // bindings + execution context for loaders/middleware to read via `appContext`.
    const context = new RouterContextProvider();
    context.set(appContext, { env, ctx });
    return reactRouterHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
