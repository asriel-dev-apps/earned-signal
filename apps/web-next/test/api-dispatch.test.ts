import { describe, expect, it, vi } from "vitest";
import worker, { isApiPath, isMcpPath } from "../workers/app";
import { fakeEnv } from "./helpers";

/**
 * The Worker-entry dispatch (ADR 0012 Step 5a): `/api*` and `/mcp*` are handled
 * by the token surfaces and never reach the React Router (cookie) pipeline, while
 * a lookalike like `/apifoo` falls through to React Router. The predicates are the
 * dispatch decision, so pinning them pins the routing; the handler drive proves
 * the entry wires the `/api` and `/mcp` branches to the right handlers.
 */

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function dispatchEnv(): Env {
  const env = fakeEnv({ OIDC_ISSUER: "https://accounts.google.example.invalid" });
  // The `/api` edge posture enforces a pre-auth rate limit before the app runs.
  (env as unknown as { PRE_AUTH_RATE_LIMIT: RateLimit }).PRE_AUTH_RATE_LIMIT = {
    limit: vi.fn(async () => ({ success: true })),
  } as unknown as RateLimit;
  return env;
}

describe("worker-entry dispatch predicates", () => {
  it("routes exact and subpath /api to the API surface, but not a lookalike", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/")).toBe(true);
    expect(isApiPath("/api/health")).toBe(true);
    expect(isApiPath("/api/tenants/t/projects/p/commands")).toBe(true);
    expect(isApiPath("/apifoo")).toBe(false);
    expect(isApiPath("/mcp")).toBe(false);
    expect(isApiPath("/")).toBe(false);
  });

  it("routes exact and subpath /mcp to the MCP surface, but not a lookalike", () => {
    expect(isMcpPath("/mcp")).toBe(true);
    expect(isMcpPath("/mcp/")).toBe(true);
    expect(isMcpPath("/mcp/message")).toBe(true);
    expect(isMcpPath("/mcpfoo")).toBe(false);
    expect(isMcpPath("/api")).toBe(false);
  });
});

describe("worker-entry dispatch handler", () => {
  it("serves /api/health through the API surface (not React Router)", async () => {
    const response = await worker.fetch(
      new Request("https://app.test/api/health") as Parameters<typeof worker.fetch>[0],
      dispatchEnv(),
      ctx,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: "vecta", status: "ok" });
    // The edge posture ran: the security headers are present on the /api response.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers /mcp with 501 (Step 5b skeleton), never React Router", async () => {
    const response = await worker.fetch(
      new Request("https://app.test/mcp", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      dispatchEnv(),
      ctx,
    );
    expect(response.status).toBe(501);
  });

  it("applies the /api pre-auth rate limit (429) through the edge posture", async () => {
    const env = dispatchEnv();
    // Deny at the pre-auth limiter → the edge wrapper maps it to 429.
    (env as unknown as { PRE_AUTH_RATE_LIMIT: RateLimit }).PRE_AUTH_RATE_LIMIT = {
      limit: vi.fn(async () => ({ success: false })),
    } as unknown as RateLimit;
    const response = await worker.fetch(
      new Request("https://app.test/api/health") as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    expect(response.status).toBe(429);
  });
});
