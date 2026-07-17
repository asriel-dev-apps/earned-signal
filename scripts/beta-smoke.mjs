#!/usr/bin/env node

import { stdin } from "node:process";

const baseUrlValue = process.env.EARNED_SIGNAL_BASE_URL;
if (baseUrlValue === undefined) {
  console.error("EARNED_SIGNAL_BASE_URL is required");
  process.exit(2);
}

const baseUrl = new URL(baseUrlValue);
if (baseUrl.username !== "" || baseUrl.password !== "") {
  console.error("EARNED_SIGNAL_BASE_URL must not contain credentials");
  process.exit(2);
}
if (baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(baseUrl.hostname)) {
  console.error("EARNED_SIGNAL_BASE_URL must use HTTPS outside localhost");
  process.exit(2);
}
baseUrl.pathname = "/";
baseUrl.search = "";
baseUrl.hash = "";

async function response(path, authorization) {
  const headers = authorization === undefined ? {} : { authorization: `Bearer ${authorization}` };
  const result = await fetch(new URL(path, baseUrl), {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (result.status >= 300 && result.status < 400) {
    throw new Error(`${path}: redirects are not accepted by the smoke test`);
  }
  for (const header of ["content-security-policy", "referrer-policy", "x-content-type-options", "x-request-id"]) {
    if (result.headers.get(header) === null) throw new Error(`${path}: missing ${header} security header`);
  }
  if (baseUrl.protocol === "https:" && result.headers.get("strict-transport-security") === null) {
    throw new Error(`${path}: missing strict-transport-security header`);
  }
  return result;
}

async function expectJson(path, predicate, authorization) {
  const result = await response(path, authorization);
  if (!result.ok) throw new Error(`${path}: expected 2xx, received ${result.status}`);
  const value = await result.json();
  if (!predicate(value)) throw new Error(`${path}: response contract did not match`);
  console.log(`ok ${path} ${result.status}`);
  return value;
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const home = await response("/");
if (!home.ok || !(home.headers.get("content-type") ?? "").includes("text/html")) {
  throw new Error(`/: expected HTML 2xx, received ${home.status}`);
}
console.log(`ok / ${home.status}`);

await expectJson("/api/health", (value) => record(value) && value.service === "earned-signal" && value.status === "ok");
await expectJson("/api/openapi.json", (value) => record(value) && record(value.paths) && record(value.paths["/api/tenants/{tenantId}/projects/{projectId}"]));
await expectJson("/.well-known/oauth-protected-resource/mcp", (value) =>
  record(value) && value.resource === new URL("/mcp", baseUrl).href && Array.isArray(value.authorization_servers));

const unauthenticatedPath = "/api/tenants/00000000-0000-4000-8000-000000000000/projects/00000000-0000-4000-8000-000000000000";
const unauthenticated = await response(unauthenticatedPath);
if (unauthenticated.status !== 401) {
  throw new Error(`${unauthenticatedPath}: expected 401 without a token, received ${unauthenticated.status}`);
}
if (!(unauthenticated.headers.get("www-authenticate") ?? "").startsWith("Bearer")) {
  throw new Error(`${unauthenticatedPath}: missing Bearer challenge`);
}
console.log(`ok protected endpoint rejects anonymous access ${unauthenticated.status}`);

if (process.env.EARNED_SIGNAL_AUTH_CHECK === "1") {
  const tenantId = process.env.EARNED_SIGNAL_TENANT_ID;
  const projectId = process.env.EARNED_SIGNAL_PROJECT_ID;
  if (tenantId === undefined || projectId === undefined) {
    throw new Error("EARNED_SIGNAL_TENANT_ID and EARNED_SIGNAL_PROJECT_ID are required for an authenticated check");
  }
  const token = (await Array.fromAsync(stdin)).join("").trim();
  if (token === "") throw new Error("A REST access token must be provided on standard input");
  const projectPath = `/api/tenants/${encodeURIComponent(tenantId)}/projects/${encodeURIComponent(projectId)}`;
  await expectJson(projectPath, (value) => record(value), token);
}

console.log("EarnedSignal read-only smoke test passed");
