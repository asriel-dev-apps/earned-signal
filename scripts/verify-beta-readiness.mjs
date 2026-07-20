#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = process.env.VECTA_ENV ?? "production";
const paths = {
  web: process.env.VECTA_WEB_CONFIG ?? resolve(repoRoot, "apps/web/wrangler.jsonc"),
};

let failures = 0;
function fail(message) {
  console.error(`not ready: ${message}`);
  failures += 1;
}

function stripJsonComments(source) {
  let result = "";
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        result += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") {
        result += character;
      }
      continue;
    }
    if (!string && character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!string && character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    result += character;
    if (string) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
    } else if (character === '"') {
      string = true;
    }
  }
  return result;
}

function load(name, path) {
  if (!existsSync(path)) {
    fail(`${name} config is missing: ${path}`);
    return null;
  }
  try {
    const root = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    const selected = root.env?.[environment];
    if (selected === undefined) {
      fail(`${name} config has no ${environment} environment: ${path}`);
      return null;
    }
    return { ...root, ...selected, env: undefined };
  } catch (error) {
    fail(`${name} config could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const web = load("web", paths.web);

if (web !== null) {
  const serialized = JSON.stringify(web);
  if (/example\.invalid|localhost|127\.0\.0\.1/.test(serialized)) {
    fail(`web ${environment} config contains a placeholder or local endpoint`);
  }
  for (const binding of web.hyperdrive ?? []) {
    if (typeof binding.id !== "string" || /^([0-9a-f])\1{31}$/i.test(binding.id)) {
      fail(`web ${environment} Hyperdrive ID is missing or a repeated-digit placeholder`);
    }
  }
  if (web.hyperdrive?.length !== 1) fail(`web ${environment} must have exactly one Hyperdrive binding`);
  if (web.observability?.enabled !== true || web.observability?.logs?.enabled !== true) {
    fail(`web ${environment} must enable Worker observability logs`);
  }
  if (web.name !== `vecta-${environment}`) {
    fail(`web ${environment} Worker name must be vecta-${environment}`);
  }
  for (const field of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URL"]) {
    if (typeof web.vars?.[field] !== "string") fail(`web ${environment} config is missing ${field}`);
  }
  const rateLimitNames = new Set(web.ratelimits?.map((binding) => binding.name) ?? []);
  for (const name of ["PRE_AUTH_RATE_LIMIT", "AUTH_RATE_LIMIT", "COMPUTE_RATE_LIMIT"]) {
    if (!rateLimitNames.has(name)) fail(`web ${environment} config is missing ${name}`);
  }
  const rateLimitIds = web.ratelimits?.map((binding) => binding.namespace_id) ?? [];
  const committedPlaceholderIds = environment === "staging" ? ["1101", "1102", "1103"] : ["1201", "1202", "1203"];
  if (rateLimitIds.length !== 3 || new Set(rateLimitIds).size !== 3 ||
      rateLimitIds.some((id) => !/^[1-9]\d*$/u.test(id) || committedPlaceholderIds.includes(id))) {
    fail(`web ${environment} rate-limit namespace IDs are missing, duplicated, or still placeholders`);
  }
  if (web.assets?.binding !== "ASSETS" || web.assets?.run_worker_first !== true) {
    fail(`web ${environment} static assets must run through the Worker security boundary`);
  }
}

for (const document of [
  ".github/workflows/deploy.yml",
  "packages/persistence/scripts/migrate.mjs",
  "docs/operations/release-and-rollback.md",
  "docs/operations/postgres-recovery.md",
  "docs/operations/monitoring-and-alerts.md",
  "docs/security/identity-and-secrets.md",
  "docs/security/privacy-and-data-lifecycle.md",
  ".github/scripts/verify-operations-evidence.mjs",
  ".github/scripts/verify-web-build.mjs",
]) {
  if (!existsSync(resolve(repoRoot, document))) fail(`missing ${document}`);
}

if (!existsSync(resolve(repoRoot, "packages/persistence/drizzle/meta/_journal.json"))) {
  fail("Drizzle migration journal is missing");
}

const diffCheck = spawnSync("git", ["diff", "--check"], { cwd: repoRoot, encoding: "utf8" });
if (diffCheck.status !== 0) {
  process.stderr.write(diffCheck.stdout);
  process.stderr.write(diffCheck.stderr);
  fail("worktree contains whitespace errors");
}

if (failures > 0) {
  console.error(`${failures} readiness check(s) failed`);
  process.exit(1);
}

console.log(`Static ${environment} beta readiness checks passed`);
console.log("Cloudflare, OIDC, PostgreSQL, backup, alert, and E2E evidence still require operator verification.");
