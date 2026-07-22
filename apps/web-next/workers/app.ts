import { Hono } from "hono";
import { createRequestHandler, type ServerBuild } from "react-router";

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
    if (pathname.startsWith("/api") || pathname.startsWith("/mcp")) {
      return api.fetch(request, env, ctx);
    }
    return reactRouterHandler(request);
  },
} satisfies ExportedHandler<Env>;
