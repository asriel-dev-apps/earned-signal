#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { stdin } from "node:process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
};

const baseUrl = new URL(required("EARNED_SIGNAL_BASE_URL"));
if (baseUrl.protocol !== "https:" || baseUrl.username !== "" || baseUrl.password !== "") {
  throw new Error("EARNED_SIGNAL_BASE_URL must be an HTTPS URL without credentials");
}
baseUrl.pathname = "/";
baseUrl.search = "";
baseUrl.hash = "";

const runId = required("EARNED_SIGNAL_E2E_RUN_ID");
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(runId)) {
  throw new Error("EARNED_SIGNAL_E2E_RUN_ID must be 1-64 safe identifier characters");
}
const config = JSON.parse(await readFile(required("EARNED_SIGNAL_E2E_CONFIG"), "utf8"));
for (const field of ["tenantId", "projectId", "crossTenantId", "crossProjectId", "baselineLabel", "restTaskUpdate", "mcpTaskUpdate", "scenario", "forecast", "staffing"]) {
  if (config[field] === undefined) throw new Error(`E2E config is missing ${field}`);
}
if (config.tenantId === config.crossTenantId) throw new Error("crossTenantId must differ from tenantId");
if (config.projectId === config.crossProjectId) throw new Error("crossProjectId must differ from projectId");
if (!Array.isArray(config.forecast.estimates) || config.forecast.estimates.length === 0 ||
    config.forecast.estimates.some((estimate) => estimate.provenance !== "HUMAN_CONFIRMED")) {
  throw new Error("Forecast estimates must be non-empty and HUMAN_CONFIRMED");
}
if (!Array.isArray(config.staffing.remainingEffort) || config.staffing.remainingEffort.length === 0 ||
    config.staffing.remainingEffort.some((estimate) => estimate.provenance !== "HUMAN_CONFIRMED")) {
  throw new Error("Staffing remaining effort must be non-empty and HUMAN_CONFIRMED");
}

const secrets = (await Array.fromAsync(stdin)).join("").split(/\r?\n/u);
const restToken = secrets[0]?.trim();
const mcpToken = secrets[1]?.trim();
const restrictedMcpToken = secrets[2]?.trim();
if (!restToken || !mcpToken || !restrictedMcpToken) {
  throw new Error("REST, MCP, and restricted-agent MCP access tokens must be provided as three lines on standard input");
}

const projectPath = `/api/tenants/${encodeURIComponent(config.tenantId)}/projects/${encodeURIComponent(config.projectId)}`;
const headers = (token, json = false) => ({
  authorization: `Bearer ${token}`,
  ...(json ? { "content-type": "application/json" } : {}),
});

async function request(path, { method = "GET", token = restToken, body, idempotencyKey } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...headers(token, body !== undefined),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { response, payload };
}

function expectStatus(result, expected, label) {
  if (!expected.includes(result.response.status)) {
    throw new Error(`${label}: expected ${expected.join("/")}, received ${result.response.status}`);
  }
  return result.payload;
}

const project = expectStatus(await request(projectPath), [200], "load synthetic project");
let revision = project.revision;
if (typeof revision !== "string") throw new Error("Project response has no revision");

const restCommand = {
  expectedRevision: revision,
  command: { type: "task.update", ...config.restTaskUpdate },
};
const restKey = `beta-e2e-rest-${runId}`;
const updated = expectStatus(await request(`${projectPath}/commands`, {
  method: "POST", body: restCommand, idempotencyKey: restKey,
}), [200], "REST task update");
revision = updated.revision;
const replay = expectStatus(await request(`${projectPath}/commands`, {
  method: "POST", body: restCommand, idempotencyKey: restKey,
}), [200], "REST idempotency replay");
if (replay.replayed !== true || replay.revision !== revision) throw new Error("REST command was not idempotently replayed");
console.log(`ok REST command and replay revision=${revision}`);

const stale = await request(`${projectPath}/commands`, {
  method: "POST",
  body: { ...restCommand, expectedRevision: project.revision },
  idempotencyKey: `beta-e2e-stale-${runId}`,
});
expectStatus(stale, [409], "stale revision rejection");
console.log("ok stale revision rejected");

const baseline = expectStatus(await request(`${projectPath}/commands`, {
  method: "POST",
  body: { expectedRevision: revision, command: { type: "baseline.publish", label: config.baselineLabel } },
  idempotencyKey: `beta-e2e-baseline-${runId}`,
}), [200], "publish baseline");
revision = baseline.revision;
const performance = expectStatus(await request(`${projectPath}/performance`), [200], "load EVM performance");
if (!Array.isArray(performance.snapshots) || performance.snapshots.length === 0 ||
    performance.snapshots.some((snapshot) => snapshot.metrics === undefined || !Array.isArray(snapshot.wbsVariances))) {
  throw new Error("EVM performance has no metric snapshots and WBS variances");
}
console.log(`ok baseline and EVM revision=${revision}`);

const currentBeforeScenario = expectStatus(await request(projectPath), [200], "load Current before Scenario");

const scenario = expectStatus(await request(`${projectPath}/scenarios`, {
  method: "POST", body: { ...config.scenario, name: `${config.scenario.name} ${runId}` },
}), [201], "create scenario");
const scenarioRun = expectStatus(await request(`${projectPath}/scenarios/${scenario.id}/runs`, {
  method: "POST", body: { expectedRevision: scenario.revision },
}), [200], "run scenario");
if (scenarioRun.latestRun?.inputHash === undefined) throw new Error("Scenario run has no deterministic result");
const currentAfterScenario = expectStatus(await request(projectPath), [200], "load Current after Scenario");
if (currentAfterScenario.revision !== currentBeforeScenario.revision ||
    JSON.stringify(currentAfterScenario.current) !== JSON.stringify(currentBeforeScenario.current)) {
  throw new Error("Scenario execution changed Current");
}
console.log(`ok scenario run id=${scenario.id}`);

const forecast = expectStatus(await request(`${projectPath}/scenarios/${scenario.id}/forecast-runs`, {
  method: "POST",
  body: { expectedRevision: revision, expectedScenarioRevision: scenario.revision, ...config.forecast },
  idempotencyKey: `beta-e2e-forecast-${runId}`,
}), [202], "request forecast").run;

async function poll(path, terminal, label) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const value = expectStatus(await request(path), [200], label);
    if (terminal.includes(value.status)) return value;
    await setTimeout(2_000);
  }
  throw new Error(`${label}: did not reach a terminal state within 180 seconds`);
}

const forecastResult = await poll(
  `${projectPath}/scenarios/${scenario.id}/forecast-runs/${forecast.id}`,
  ["READY", "FAILED"],
  "poll forecast",
);
if (forecastResult.status !== "READY") throw new Error("Forecast reached FAILED; inspect simulator logs and run record");
console.log(`ok forecast READY id=${forecast.id}`);

const proposal = expectStatus(await request(`${projectPath}/staffing-proposals`, {
  method: "POST",
  body: { ...config.staffing, name: `${config.staffing.name} ${runId}`, expectedRevision: revision },
  idempotencyKey: `beta-e2e-staffing-${runId}`,
}), [202], "request staffing proposal").proposal;
const proposalResult = await poll(
  `${projectPath}/staffing-proposals/${proposal.id}`,
  ["READY", "INFEASIBLE", "UNKNOWN", "FAILED"],
  "poll staffing proposal",
);
if (proposalResult.status !== "READY" || typeof proposalResult.linkedScenarioId !== "string") {
  throw new Error(`Staffing proposal reached ${proposalResult.status} without a linked Scenario`);
}
console.log(`ok staffing proposal ${proposalResult.status} id=${proposal.id}`);

const crossTenant = await request(
  `/api/tenants/${encodeURIComponent(config.crossTenantId)}/projects/${encodeURIComponent(config.projectId)}`,
);
expectStatus(crossTenant, [403, 404], "cross-tenant rejection");
console.log("ok cross-tenant access rejected");
const crossProject = await request(
  `/api/tenants/${encodeURIComponent(config.tenantId)}/projects/${encodeURIComponent(config.crossProjectId)}`,
);
expectStatus(crossProject, [403, 404], "cross-project rejection");
console.log("ok cross-project access rejected");

expectStatus(await request(projectPath, { token: mcpToken }), [401], "MCP token at REST audience");

async function mcpRpc(method, params, sessionId, token = mcpToken) {
  const response = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      ...headers(token, true),
      accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`MCP ${method}: received ${response.status}`);
  const text = await response.text();
  const dataLine = text.split(/\r?\n/u).find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine?.slice(6) ?? text);
  if (payload.error !== undefined) throw new Error(`MCP ${method}: ${payload.error.code ?? "protocol error"}`);
  return { payload: payload.result, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

const initialized = await mcpRpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "earned-signal-beta-e2e", version: "1.0.0" },
});
if (!initialized.sessionId) throw new Error("MCP server did not establish a session");
async function notifyInitialized(sessionId, token) {
  const response = await fetch(new URL("/mcp", baseUrl), {
  method: "POST",
  headers: {
    ...headers(token, true),
    accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
  },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`MCP initialized notification: received ${response.status}`);
}
await notifyInitialized(initialized.sessionId, mcpToken);
await mcpRpc("tools/call", {
  name: "list_staffing_proposals",
  arguments: { tenantId: config.tenantId, projectId: config.projectId },
}, initialized.sessionId);
const beforeMcp = expectStatus(await request(projectPath), [200], "load revision before MCP");
const mcpKey = `beta-e2e-mcp-${runId}`;
const mcpUpdate = await mcpRpc("tools/call", {
  name: "update_project_task",
  arguments: {
    tenantId: config.tenantId,
    projectId: config.projectId,
    expectedRevision: beforeMcp.revision,
    idempotencyKey: mcpKey,
    ...config.mcpTaskUpdate,
  },
}, initialized.sessionId);
if (mcpUpdate.payload.isError === true) throw new Error("MCP task update returned a tool error");
const mcpReplay = await mcpRpc("tools/call", {
  name: "update_project_task",
  arguments: {
    tenantId: config.tenantId,
    projectId: config.projectId,
    expectedRevision: beforeMcp.revision,
    idempotencyKey: mcpKey,
    ...config.mcpTaskUpdate,
  },
}, initialized.sessionId);
if (mcpReplay.payload.structuredContent?.replayed !== true) throw new Error("MCP command was not idempotently replayed");
console.log("ok MCP read, command, and replay");

const wrongAudienceInitialize = await fetch(new URL("/mcp", baseUrl), {
  method: "POST",
  headers: { ...headers(restToken, true), accept: "application/json, text/event-stream" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: randomUUID(), method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "earned-signal-beta-e2e", version: "1.0.0" } },
  }),
  signal: AbortSignal.timeout(30_000),
});
if (wrongAudienceInitialize.status !== 401) throw new Error("REST token was accepted at the MCP audience");

const restricted = await mcpRpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "earned-signal-beta-e2e-restricted", version: "1.0.0" },
}, undefined, restrictedMcpToken);
if (!restricted.sessionId) throw new Error("Restricted MCP client did not establish a session");
await notifyInitialized(restricted.sessionId, restrictedMcpToken);
const restrictedUpdate = await mcpRpc("tools/call", {
  name: "update_project_task",
  arguments: {
    tenantId: config.tenantId,
    projectId: config.projectId,
    expectedRevision: mcpReplay.payload.structuredContent.revision,
    idempotencyKey: `beta-e2e-restricted-${runId}`,
    ...config.mcpTaskUpdate,
  },
}, restricted.sessionId, restrictedMcpToken);
const restrictedErrorText = restrictedUpdate.payload.content?.find((entry) => entry.type === "text")?.text;
let restrictedErrorCode;
try {
  restrictedErrorCode = JSON.parse(restrictedErrorText ?? "null")?.error?.code;
} catch {
  restrictedErrorCode = undefined;
}
if (restrictedUpdate.payload.isError !== true || restrictedErrorCode !== "PROJECT_ACCESS_DENIED") {
  throw new Error("Restricted agent scope did not return PROJECT_ACCESS_DENIED");
}
console.log("ok REST/MCP audiences and restricted agent scope rejected");

expectStatus(await request(`${projectPath}/scenarios/${scenario.id}/discard`, {
  method: "POST", body: { expectedRevision: scenario.revision },
}), [200], "discard synthetic scenario");
console.log("EarnedSignal authenticated beta E2E passed");
