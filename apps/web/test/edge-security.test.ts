import { describe, expect, it, vi } from "vitest";
import {
  boundedRequest,
  enforceAuthenticatedLimits,
  enforcePreAuthenticationLimit,
  errorName,
  requestId,
  RequestRateLimitedError,
  routeKey,
  secureResponse,
  withRequestId,
  writeHttpRequestLog,
} from "../src/edge-security.js";

function limiter(success = true) {
  return {
    limit: vi.fn(async (options: RateLimitOptions) => {
      void options;
      return { success };
    }),
  } satisfies RateLimit;
}

describe("edge request security", () => {
  it("normalizes tenant and project identifiers into bounded route classes", () => {
    const first = new Request("https://app.test/api/tenants/tenant-a/projects/project-a/commands", { method: "POST" });
    const second = new Request("https://app.test/api/tenants/tenant-b/projects/project-b/commands", { method: "POST" });
    expect(routeKey(first)).toBe("POST:commands");
    expect(routeKey(second)).toBe(routeKey(first));
    expect(routeKey(new Request("https://app.test/api/tenants/t/projects/p/wbs-grid"))).toBe("GET:wbs-grid");
    expect(routeKey(new Request("https://app.test/api/tenants/t/projects/p"))).toBe("GET:project");
    expect(routeKey(new Request("https://app.test/api/health"))).toBe("GET:api-health");
    expect(routeKey(new Request("https://app.test/.well-known/oauth-protected-resource"))).toBe("GET:oauth-metadata");
    expect(routeKey(new Request("https://app.test/assets/index.js"))).toBe("GET:static-or-unknown");
  });

  it("applies a pre-authentication IP and route limit without exposing the raw key", async () => {
    const rateLimit = limiter();
    await enforcePreAuthenticationLimit(
      rateLimit,
      new Request("https://app.test/api/tenants/t/projects/p/commands", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.8" },
      }),
    );
    const key = rateLimit.limit.mock.calls[0]?.[0].key;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("203.0.113.8");
  });

  it("applies a principal-scoped authenticated limit without exposing the principal", async () => {
    const authenticated = limiter();
    await enforceAuthenticatedLimits(
      authenticated,
      new Request("https://app.test/api/tenants/tenant-a/projects/project-a/commands", { method: "POST" }),
      { issuer: "https://identity.test/", subject: "principal@example.test", scopes: [] },
    );
    expect(authenticated.limit).toHaveBeenCalledOnce();
    const key = authenticated.limit.mock.calls[0]?.[0].key;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("principal@example.test");
  });

  it("fails closed when a native rate limiter rejects the key", async () => {
    await expect(enforcePreAuthenticationLimit(
      limiter(false),
      new Request("https://app.test/api/health"),
    )).rejects.toBeInstanceOf(RequestRateLimitedError);
  });

  it("rejects declared and streamed bodies above the limit and preserves bounded bodies", async () => {
    const declared = new Request("https://app.test/api/test", {
      method: "POST",
      headers: { "content-length": "65537" },
      body: "x",
    });
    expect(await boundedRequest(declared)).toBeNull();

    const streamed = new Request("https://app.test/api/test", {
      method: "POST",
      body: "x".repeat(65_537),
    });
    expect(await boundedRequest(streamed)).toBeNull();

    const bounded = await boundedRequest(new Request("https://app.test/api/test", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    }));
    expect(await bounded?.json()).toEqual({ ok: true });
  });

  it("generates an internal correlation ID and applies API security headers", () => {
    const id = requestId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const request = new Request("https://app.test/api/health", {
      headers: { "x-request-id": "attacker-controlled" },
    });
    expect(withRequestId(request, id).headers.get("x-request-id")).toBe(id);
    const response = secureResponse(request, Response.json({ ok: true }), id);
    expect(response.headers.get("x-request-id")).toBe(id);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("permissions-policy")).not.toBeNull();
  });

  it("uses a static-safe CSP outside API routes and never logs exception messages", () => {
    const response = secureResponse(
      new Request("https://app.test/assets/index.js"),
      new Response("asset"),
      "request-id",
      "https://identity.test/tenant",
    );
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self' https://identity.test");
    expect(response.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
    const local = secureResponse(
      new Request("http://127.0.0.1:4173/"),
      new Response("preview"),
      "request-id",
      "http://127.0.0.1:9000/",
    );
    expect(local.headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests");
    expect(errorName(new Error("authorization=Bearer secret-token"))).toBe("Error");
  });

  it("writes machine-readable request logs without URLs, principals, tokens, or error messages", () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => undefined);
    writeHttpRequestLog({
      requestId: "request-1",
      method: "POST",
      route: "POST:commands",
      status: 500,
      durationMs: 12,
      error: new Error("Bearer secret-token for principal@example.test at /private/path"),
    });
    expect(write).toHaveBeenCalledOnce();
    const serialized = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(serialized)).toEqual({
      event: "http_request",
      requestId: "request-1",
      method: "POST",
      route: "POST:commands",
      status: 500,
      durationMs: 12,
      errorName: "Error",
    });
    expect(serialized).not.toMatch(/secret-token|principal@|private\/path/);
    write.mockRestore();
  });
});
