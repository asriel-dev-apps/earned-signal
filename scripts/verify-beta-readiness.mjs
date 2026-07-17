#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = process.env.EARNED_SIGNAL_ENV ?? "production";
const paths = {
  web: process.env.EARNED_SIGNAL_WEB_CONFIG ?? resolve(repoRoot, "apps/web/wrangler.jsonc"),
  optimizer: process.env.EARNED_SIGNAL_OPTIMIZER_CONFIG ?? resolve(repoRoot, "apps/optimizer/wrangler.jsonc"),
  simulator: process.env.EARNED_SIGNAL_SIMULATOR_CONFIG ?? resolve(repoRoot, "apps/simulator/wrangler.jsonc"),
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

const configs = {
  web: load("web", paths.web),
  optimizer: load("optimizer", paths.optimizer),
  simulator: load("simulator", paths.simulator),
};

for (const [name, config] of Object.entries(configs)) {
  if (config === null) continue;
  const serialized = JSON.stringify(config);
  if (/example\.invalid|localhost|127\.0\.0\.1/.test(serialized)) {
    fail(`${name} ${environment} config contains a placeholder or local endpoint`);
  }
  for (const binding of config.hyperdrive ?? []) {
    if (typeof binding.id !== "string" || /^([0-9a-f])\1{31}$/i.test(binding.id)) {
      fail(`${name} ${environment} Hyperdrive ID is missing or a repeated-digit placeholder`);
    }
  }
  if (config.hyperdrive?.length !== 1) fail(`${name} ${environment} must have exactly one Hyperdrive binding`);
  if (config.observability?.enabled !== true || config.observability?.logs?.enabled !== true) {
    fail(`${name} ${environment} must enable Worker observability logs`);
  }
}

const hyperdriveIds = Object.values(configs)
  .flatMap((config) => config?.hyperdrive?.map((binding) => binding.id) ?? []);
if (new Set(hyperdriveIds).size !== 1) {
  fail(`all ${environment} Workers must use the same Hyperdrive configuration`);
}

const expectedWorkerNames = {
  web: `earned-signal-${environment}`,
  optimizer: `earned-signal-optimizer-${environment}`,
  simulator: `earned-signal-simulator-${environment}`,
};
for (const [name, expectedName] of Object.entries(expectedWorkerNames)) {
  if (configs[name]?.name !== expectedName) fail(`${name} ${environment} Worker name must be ${expectedName}`);
}

for (const field of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URL", "MCP_RESOURCE_URL"]) {
  if (typeof configs.web?.vars?.[field] !== "string") fail(`web ${environment} config is missing ${field}`);
}

const expectedQueue = `earned-signal-${environment}-forecast-runs`;
const producerQueues = configs.web?.queues?.producers?.map((producer) => producer.queue) ?? [];
if (!producerQueues.includes(expectedQueue)) fail(`web ${environment} config does not produce to ${expectedQueue}`);

const consumers = configs.simulator?.queues?.consumers ?? [];
const primaryConsumer = consumers.find((consumer) => consumer.queue === expectedQueue);
if (primaryConsumer?.dead_letter_queue !== `${expectedQueue}-dlq`) {
  fail(`simulator ${environment} config does not route exhausted messages to ${expectedQueue}-dlq`);
}
if (!consumers.some((consumer) => consumer.queue === `${expectedQueue}-dlq`)) {
  fail(`simulator ${environment} config has no consumer for ${expectedQueue}-dlq`);
}
if (configs.simulator?.vars?.EXPECTED_FORECAST_QUEUE !== expectedQueue ||
    configs.simulator?.vars?.EXPECTED_FORECAST_DLQ !== `${expectedQueue}-dlq`) {
  fail(`simulator ${environment} expected Queue vars do not match its consumers`);
}

const expectedWorkflow = `earned-signal-${environment}-staffing-proposals`;
const optimizerWorkflow = configs.optimizer?.workflows?.find((workflow) => workflow.binding === "STAFFING_WORKFLOW");
const webWorkflow = configs.web?.workflows?.find((workflow) => workflow.binding === "STAFFING_WORKFLOW");
if (optimizerWorkflow?.name !== expectedWorkflow) {
  fail(`optimizer ${environment} Workflow name must be ${expectedWorkflow}`);
}
if (webWorkflow?.name !== expectedWorkflow || webWorkflow?.script_name !== expectedWorkerNames.optimizer) {
  fail(`web ${environment} Workflow binding does not target ${expectedWorkerNames.optimizer}`);
}

const rateLimitNames = new Set(configs.web?.ratelimits?.map((binding) => binding.name) ?? []);
for (const name of ["PRE_AUTH_RATE_LIMIT", "AUTH_RATE_LIMIT", "COMPUTE_RATE_LIMIT"]) {
  if (!rateLimitNames.has(name)) fail(`web ${environment} config is missing ${name}`);
}
const rateLimitIds = configs.web?.ratelimits?.map((binding) => binding.namespace_id) ?? [];
const committedPlaceholderIds = environment === "staging" ? ["1101", "1102", "1103"] : ["1201", "1202", "1203"];
if (rateLimitIds.length !== 3 || new Set(rateLimitIds).size !== 3 ||
    rateLimitIds.some((id) => !/^[1-9]\d*$/u.test(id) || committedPlaceholderIds.includes(id))) {
  fail(`web ${environment} rate-limit namespace IDs are missing, duplicated, or still placeholders`);
}
if (configs.web?.assets?.binding !== "ASSETS" || configs.web?.assets?.run_worker_first !== true) {
  fail(`web ${environment} static assets must run through the Worker security boundary`);
}

for (const document of [
  ".github/workflows/deploy.yml",
  "packages/persistence/scripts/migrate.mjs",
  "docs/operations/release-and-rollback.md",
  "docs/operations/postgres-recovery.md",
  "docs/operations/monitoring-and-alerts.md",
  "docs/operations/async-processing-incidents.md",
  "docs/operations/public-beta-go-live.md",
  "docs/security/identity-and-secrets.md",
  "docs/security/privacy-and-data-lifecycle.md",
  "scripts/beta-e2e.mjs",
  "scripts/beta-e2e.example.json",
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
