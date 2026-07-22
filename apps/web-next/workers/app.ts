import { Hono } from "hono";
import {
  createRequestHandler,
  RouterContextProvider,
  type ServerBuild,
} from "react-router";
import { appContext } from "../app/server/context";

const reactRouterHandler = createRequestHandler(
  // React Router's generated virtual-build exports type each optional field as
  // `T | undefined`, which the repo's `exactOptionalPropertyTypes` rejects
  // against `ServerBuild`'s `field?: T`. The runtime shape is correct, so bridge
  // the generated type to `ServerBuild` explicitly.
  () =>
    import("virtual:react-router/server-build") as unknown as Promise<ServerBuild>,
  import.meta.env.MODE,
);

// External API + MCP surface (ADR 0012 §Decision 3). The full `/api` (zod-openapi)
// and `/mcp` server land in later steps; this is the dispatch skeleton only.
// These surfaces are cookie-session-free by construction: they are dispatched to
// Hono here and never reach the React Router auth middleware.
const api = new Hono<{ Bindings: Env }>();

api.get("/api/health", (c) => c.json({ status: "ok" }));

api.all("/mcp", (c) =>
  c.json({ error: "mcp not implemented (ADR 0012 step 5)" }, 501),
);
api.all("/mcp/*", (c) =>
  c.json({ error: "mcp not implemented (ADR 0012 step 5)" }, 501),
);

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Exact-or-subpath match so `/apifoo`/`/mcpfoo` fall through to React Router
    // instead of being misrouted to the API/MCP surface.
    if (
      pathname === "/api" ||
      pathname.startsWith("/api/") ||
      pathname === "/mcp" ||
      pathname.startsWith("/mcp/")
    ) {
      return api.fetch(request, env, ctx);
    }
    // React Router v8 requires the load context to be a `RouterContextProvider`
    // (a plain object no longer type-checks or works). Seed it with the Worker
    // bindings + execution context for loaders/middleware to read via `appContext`.
    const context = new RouterContextProvider();
    context.set(appContext, { env, ctx });
    return reactRouterHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
