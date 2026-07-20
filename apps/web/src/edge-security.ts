import type { AuthenticatedIdentity } from "@earned-signal/application";

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_PERIOD_SECONDS = 60;

export class RequestRateLimitedError extends Error {
  constructor() {
    super("Request rate limit exceeded");
    this.name = "RequestRateLimitedError";
  }
}

function routeParts(pathname: string): readonly string[] {
  return pathname.split("/").filter((part) => part.length > 0);
}

export function routeKey(request: Request): string {
  const url = new URL(request.url);
  const parts = routeParts(url.pathname);
  const method = request.method.toUpperCase();
  if (parts[0] === "api" && parts[1] === "health") return `${method}:api-health`;
  if (parts[0] === ".well-known") return `${method}:oauth-metadata`;
  if (parts[0] !== "api" || parts[1] !== "tenants") return `${method}:static-or-unknown`;

  const resource = parts.slice(5);
  if (resource[0] === "commands") return `${method}:commands`;
  if (resource[0] === "wbs-grid") return `${method}:wbs-grid`;
  return `${method}:project`;
}

async function digestKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireRateLimit(limiter: RateLimit, key: string): Promise<void> {
  if (!(await limiter.limit({ key: await digestKey(key) })).success) {
    throw new RequestRateLimitedError();
  }
}

export async function enforcePreAuthenticationLimit(
  limiter: RateLimit,
  request: Request,
): Promise<void> {
  const source = request.headers.get("cf-connecting-ip") ?? "unknown-source";
  await requireRateLimit(limiter, `pre:${source}:${routeKey(request)}`);
}

export async function enforceAuthenticatedLimits(
  authenticatedLimiter: RateLimit,
  request: Request,
  identity: AuthenticatedIdentity,
): Promise<void> {
  const principal = `${identity.issuer}:${identity.subject}`;
  await requireRateLimit(authenticatedLimiter, `auth:${principal}:${routeKey(request)}`);
}

export async function boundedRequest(
  request: Request,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<Request | null> {
  if (request.body === null) return request;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) return null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}

export function requestId(): string {
  return crypto.randomUUID();
}

export function withRequestId(request: Request, id: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", id);
  return new Request(request, { headers });
}

function isApiResponse(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith("/api/") || pathname.startsWith("/.well-known/");
}

function allowedConnectSource(oidcIssuer: string | undefined): string {
  if (oidcIssuer === undefined) return "'self'";
  try {
    const issuer = new URL(oidcIssuer);
    const loopback = issuer.hostname === "localhost" || issuer.hostname === "127.0.0.1";
    return issuer.protocol === "https:" || (issuer.protocol === "http:" && loopback)
      ? `'self' ${issuer.origin}`
      : "'self'";
  } catch {
    return "'self'";
  }
}

export function secureResponse(
  request: Request,
  response: Response,
  id: string,
  oidcIssuer?: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", id);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Origin-Agent-Cluster", "?1");
  headers.delete("Server");
  if (new URL(request.url).protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  if (isApiResponse(request)) {
    headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    headers.set("Cache-Control", "no-store");
  } else {
    const upgrade = new URL(request.url).protocol === "https:" ? "; upgrade-insecure-requests" : "";
    headers.set("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${allowedConnectSource(oidcIssuer)}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'${upgrade}`);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function rateLimitedResponse(): Response {
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests" } },
    { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS) } },
  );
}

export function bodyTooLargeResponse(): Response {
  return Response.json(
    { error: { code: "BODY_TOO_LARGE", message: "Request body exceeds 64 KiB" } },
    { status: 413, headers: { "Cache-Control": "no-store" } },
  );
}

export function internalErrorResponse(): Response {
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : "UnknownError";
}

export function writeHttpRequestLog(input: {
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly error?: unknown;
}): void {
  const record: Record<string, string | number> = {
    event: "http_request",
    requestId: input.requestId,
    method: input.method,
    route: input.route,
    status: input.status,
    durationMs: input.durationMs,
  };
  if (input.error !== undefined) record.errorName = errorName(input.error);
  const serialized = JSON.stringify(record);
  if (input.status >= 500) console.error(serialized);
  else console.log(serialized);
}
