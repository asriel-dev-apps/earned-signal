import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { forecastRunAuditEvents, forecastRunResults, forecastRuns, projects, scenarios, schema } from "./schema.js";

export type ForecastJson = null | boolean | number | string | readonly ForecastJson[] | { readonly [key: string]: ForecastJson };
export interface ForecastActor { readonly type: "HUMAN" | "AGENT" | "SYSTEM"; readonly id: string }
export type ForecastRunStatus = "REQUESTED" | "RUNNING" | "READY" | "FAILED";

export interface ForecastRunResult {
  readonly id: string;
  readonly status: "READY" | "FAILED";
  readonly algorithmVersion: string;
  readonly output: ForecastJson;
  readonly actor: ForecastActor;
  readonly createdAt: string;
}

export interface ForecastRun {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly scenarioId: string;
  readonly status: ForecastRunStatus;
  readonly sourceProjectRevision: bigint;
  readonly sourceScenarioRevision: bigint;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly input: ForecastJson;
  readonly latestResult: ForecastRunResult | null;
  readonly createdBy: ForecastActor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ForecastRunAuditEvent {
  readonly sequence: bigint;
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly scenarioId: string;
  readonly forecastRunId: string;
  readonly actor: ForecastActor;
  readonly eventType: string;
  readonly payload: ForecastJson;
  readonly occurredAt: string;
}

export interface CreateForecastRunRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly scenarioId: string;
  readonly sourceProjectRevision: bigint;
  readonly sourceScenarioRevision: bigint;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly input: ForecastJson;
  readonly actor: ForecastActor;
}

interface ForecastRunIdentity {
  readonly tenantId: string;
  readonly projectId: string;
  readonly scenarioId: string;
  readonly forecastRunId: string;
}

type Transaction = Parameters<Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]>[0];

export class ForecastRunNotFoundError extends Error {
  constructor(readonly forecastRunId: string) { super(`Forecast Run ${forecastRunId} was not found`); this.name = "ForecastRunNotFoundError"; }
}
export class ForecastRunIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) { super(`Idempotency key ${idempotencyKey} represents a different Forecast Run request`); this.name = "ForecastRunIdempotencyConflictError"; }
}
export class ForecastRunStaleError extends Error {
  constructor(readonly sourceProjectRevision: bigint, readonly currentProjectRevision: bigint, readonly sourceScenarioRevision: bigint, readonly currentScenarioRevision: bigint) {
    super(`Forecast Run revisions Project ${sourceProjectRevision}/${currentProjectRevision}, Scenario ${sourceScenarioRevision}/${currentScenarioRevision} are stale`);
    this.name = "ForecastRunStaleError";
  }
}
export class ForecastRunTransitionError extends Error {
  constructor(readonly currentStatus: ForecastRunStatus, readonly requestedStatus: ForecastRunStatus) { super(`Forecast Run cannot transition from ${currentStatus} to ${requestedStatus}`); this.name = "ForecastRunTransitionError"; }
}

function assertActor(actor: ForecastActor): void { if (actor.id.trim().length === 0) throw new Error("Forecast actor ID must not be blank"); }
function assertJson(value: unknown, path = "value"): asserts value is ForecastJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`); return; }
  if (Array.isArray(value)) { value.forEach((entry, index) => assertJson(entry, `${path}[${index}]`)); return; }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value)) { if (entry === undefined) throw new Error(`${path}.${key} must not be undefined`); assertJson(entry, `${path}.${key}`); }
    return;
  }
  throw new Error(`${path} must be JSON-safe`);
}

function asResult(row: typeof forecastRunResults.$inferSelect): ForecastRunResult {
  if (row.status !== "READY" && row.status !== "FAILED") throw new Error(`Forecast result has non-terminal status ${row.status}`);
  return { id: row.id, status: row.status, algorithmVersion: row.algorithmVersion, output: row.output as ForecastJson, actor: { type: row.actorType, id: row.actorId }, createdAt: row.createdAt };
}

async function loadResult(database: NodePgDatabase<typeof schema> | Transaction, row: typeof forecastRuns.$inferSelect): Promise<ForecastRunResult | null> {
  if (row.latestResultId === null) return null;
  const [result] = await database.select().from(forecastRunResults).where(and(
    eq(forecastRunResults.tenantId, row.tenantId), eq(forecastRunResults.projectId, row.projectId), eq(forecastRunResults.scenarioId, row.scenarioId), eq(forecastRunResults.forecastRunId, row.id), eq(forecastRunResults.id, row.latestResultId),
  )).limit(1);
  if (result === undefined) throw new Error(`Forecast Run ${row.id} references a missing result`);
  return asResult(result);
}

async function asForecastRun(database: NodePgDatabase<typeof schema> | Transaction, row: typeof forecastRuns.$inferSelect): Promise<ForecastRun> {
  return forecastRun(row, await loadResult(database, row));
}

function forecastRun(row: typeof forecastRuns.$inferSelect, latestResult: ForecastRunResult | null): ForecastRun {
  return {
    id: row.id, tenantId: row.tenantId, projectId: row.projectId, scenarioId: row.scenarioId, status: row.status,
    sourceProjectRevision: row.sourceProjectRevision, sourceScenarioRevision: row.sourceScenarioRevision,
    idempotencyKey: row.idempotencyKey, requestHash: row.requestHash, input: row.input as ForecastJson,
    latestResult, createdBy: { type: row.createdByType, id: row.createdBy },
    createdAt: row.createdAt, updatedAt: row.updatedAt, startedAt: row.startedAt, completedAt: row.completedAt,
  };
}

async function lockSources(transaction: Transaction, request: Pick<CreateForecastRunRequest, "tenantId" | "projectId" | "scenarioId">): Promise<{ projectRevision: bigint; scenarioRevision: bigint }> {
  const [project] = await transaction.select({ revision: projects.revision }).from(projects).where(and(eq(projects.tenantId, request.tenantId), eq(projects.id, request.projectId))).for("update").limit(1);
  const [scenario] = await transaction.select({ revision: scenarios.revision, baseProjectRevision: scenarios.baseProjectRevision, status: scenarios.status }).from(scenarios).where(and(eq(scenarios.tenantId, request.tenantId), eq(scenarios.projectId, request.projectId), eq(scenarios.id, request.scenarioId))).for("update").limit(1);
  if (project === undefined || scenario === undefined) throw new Error("Forecast source Project or Scenario was not found");
  if (scenario.status !== "DRAFT") throw new Error("Forecast Run requires a DRAFT Scenario");
  if (scenario.baseProjectRevision !== project.revision) throw new ForecastRunStaleError(scenario.baseProjectRevision, project.revision, scenario.revision, scenario.revision);
  return { projectRevision: project.revision, scenarioRevision: scenario.revision };
}

async function lockRun(transaction: Transaction, identity: ForecastRunIdentity): Promise<typeof forecastRuns.$inferSelect> {
  const [run] = await transaction.select().from(forecastRuns).where(and(eq(forecastRuns.tenantId, identity.tenantId), eq(forecastRuns.projectId, identity.projectId), eq(forecastRuns.scenarioId, identity.scenarioId), eq(forecastRuns.id, identity.forecastRunId))).for("update").limit(1);
  if (run === undefined) throw new ForecastRunNotFoundError(identity.forecastRunId);
  return run;
}

function requireCurrent(run: typeof forecastRuns.$inferSelect, revisions: { projectRevision: bigint; scenarioRevision: bigint }): void {
  if (run.sourceProjectRevision !== revisions.projectRevision || run.sourceScenarioRevision !== revisions.scenarioRevision) throw new ForecastRunStaleError(run.sourceProjectRevision, revisions.projectRevision, run.sourceScenarioRevision, revisions.scenarioRevision);
}

async function appendAudit(transaction: Transaction, identity: ForecastRunIdentity, actor: ForecastActor, eventType: string, payload: ForecastJson): Promise<void> {
  await transaction.insert(forecastRunAuditEvents).values({ ...identity, actorType: actor.type, actorId: actor.id, eventType, payload });
}

export class ProjectForecastRunRepository {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async create(request: CreateForecastRunRequest): Promise<{ readonly run: ForecastRun; readonly replayed: boolean }> {
    assertActor(request.actor); assertJson(request.input, "Forecast input");
    if (!/^[0-9a-f]{64}$/.test(request.requestHash)) throw new Error("Forecast request hash must be lowercase SHA-256 hex");
    const idempotencyKey = request.idempotencyKey.trim();
    if (idempotencyKey.length === 0 || idempotencyKey.length > 200) throw new Error("Forecast idempotency key must contain 1 to 200 characters");
    return this.database.transaction(async (transaction) => {
      const findExisting = () => transaction.select().from(forecastRuns).where(and(eq(forecastRuns.tenantId, request.tenantId), eq(forecastRuns.projectId, request.projectId), eq(forecastRuns.scenarioId, request.scenarioId), eq(forecastRuns.idempotencyKey, idempotencyKey))).limit(1);
      const replay = async (existing: typeof forecastRuns.$inferSelect) => {
        if (existing.requestHash !== request.requestHash) throw new ForecastRunIdempotencyConflictError(idempotencyKey);
        return { run: await asForecastRun(transaction, existing), replayed: true } as const;
      };
      const [existing] = await findExisting();
      if (existing !== undefined) return replay(existing);
      const revisions = await lockSources(transaction, request);
      const [concurrent] = await findExisting();
      if (concurrent !== undefined) return replay(concurrent);
      if (request.sourceProjectRevision !== revisions.projectRevision || request.sourceScenarioRevision !== revisions.scenarioRevision) throw new ForecastRunStaleError(request.sourceProjectRevision, revisions.projectRevision, request.sourceScenarioRevision, revisions.scenarioRevision);
      const [created] = await transaction.insert(forecastRuns).values({
        tenantId: request.tenantId, projectId: request.projectId, scenarioId: request.scenarioId,
        sourceProjectRevision: request.sourceProjectRevision, sourceScenarioRevision: request.sourceScenarioRevision,
        idempotencyKey, requestHash: request.requestHash, input: request.input, createdByType: request.actor.type, createdBy: request.actor.id,
      }).returning();
      if (created === undefined) throw new Error("Forecast Run was not created");
      const identity = { tenantId: created.tenantId, projectId: created.projectId, scenarioId: created.scenarioId, forecastRunId: created.id };
      await appendAudit(transaction, identity, request.actor, "forecast_run.created", { sourceProjectRevision: created.sourceProjectRevision.toString(), sourceScenarioRevision: created.sourceScenarioRevision.toString(), requestHash: created.requestHash });
      return { run: await asForecastRun(transaction, created), replayed: false } as const;
    });
  }

  async list(tenantId: string, projectId: string, scenarioId: string): Promise<readonly ForecastRun[]> {
    const rows = await this.database.select({ run: forecastRuns, result: forecastRunResults }).from(forecastRuns).leftJoin(forecastRunResults, and(
      eq(forecastRunResults.tenantId, forecastRuns.tenantId),
      eq(forecastRunResults.projectId, forecastRuns.projectId),
      eq(forecastRunResults.scenarioId, forecastRuns.scenarioId),
      eq(forecastRunResults.forecastRunId, forecastRuns.id),
      eq(forecastRunResults.id, forecastRuns.latestResultId),
    )).where(and(eq(forecastRuns.tenantId, tenantId), eq(forecastRuns.projectId, projectId), eq(forecastRuns.scenarioId, scenarioId))).orderBy(desc(forecastRuns.createdAt), asc(forecastRuns.id)).limit(50);
    return rows.map(({ run, result }) => forecastRun(run, result === null ? null : asResult(result)));
  }

  async load(tenantId: string, projectId: string, scenarioId: string, forecastRunId: string): Promise<ForecastRun | null> {
    const [row] = await this.database.select().from(forecastRuns).where(and(eq(forecastRuns.tenantId, tenantId), eq(forecastRuns.projectId, projectId), eq(forecastRuns.scenarioId, scenarioId), eq(forecastRuns.id, forecastRunId))).limit(1);
    return row === undefined ? null : asForecastRun(this.database, row);
  }

  async markRunning(request: ForecastRunIdentity & { readonly actor: ForecastActor }): Promise<ForecastRun> {
    assertActor(request.actor);
    return this.database.transaction(async (transaction) => {
      const [observed] = await transaction.select().from(forecastRuns).where(and(eq(forecastRuns.tenantId, request.tenantId), eq(forecastRuns.projectId, request.projectId), eq(forecastRuns.scenarioId, request.scenarioId), eq(forecastRuns.id, request.forecastRunId))).limit(1);
      if (observed === undefined) throw new ForecastRunNotFoundError(request.forecastRunId);
      if (observed.status !== "REQUESTED") return asForecastRun(transaction, observed);
      const revisions = await lockSources(transaction, request);
      const run = await lockRun(transaction, request);
      if (run.status !== "REQUESTED") return asForecastRun(transaction, run);
      requireCurrent(run, revisions);
      const [updated] = await transaction.update(forecastRuns).set({ status: "RUNNING", startedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(forecastRuns.tenantId, request.tenantId), eq(forecastRuns.projectId, request.projectId), eq(forecastRuns.scenarioId, request.scenarioId), eq(forecastRuns.id, request.forecastRunId), eq(forecastRuns.status, "REQUESTED"))).returning();
      if (updated === undefined) throw new ForecastRunNotFoundError(request.forecastRunId);
      await appendAudit(transaction, request, request.actor, "forecast_run.running", {});
      return asForecastRun(transaction, updated);
    });
  }

  async complete(request: ForecastRunIdentity & { readonly status: "READY" | "FAILED"; readonly algorithmVersion: string; readonly output: unknown; readonly actor: ForecastActor }): Promise<{ readonly run: ForecastRun; readonly result: ForecastRunResult; readonly accepted: boolean }> {
    assertActor(request.actor);
    const output = request.output;
    assertJson(output, "Forecast output");
    const algorithmVersion = request.algorithmVersion.trim();
    if (algorithmVersion.length === 0 || algorithmVersion.length > 100) throw new Error("Forecast algorithm version must contain 1 to 100 characters");
    return this.database.transaction(async (transaction) => {
      const [observed] = await transaction.select().from(forecastRuns).where(and(eq(forecastRuns.tenantId, request.tenantId), eq(forecastRuns.projectId, request.projectId), eq(forecastRuns.scenarioId, request.scenarioId), eq(forecastRuns.id, request.forecastRunId))).limit(1);
      if (observed === undefined) throw new ForecastRunNotFoundError(request.forecastRunId);
      if (observed.status === "READY" || observed.status === "FAILED") {
        const result = await loadResult(transaction, observed);
        if (result === null) throw new Error(`Terminal Forecast Run ${observed.id} has no result`);
        return { run: await asForecastRun(transaction, observed), result, accepted: false } as const;
      }
      if (request.status === "FAILED") {
        const run = await lockRun(transaction, request);
        if (run.status === "READY" || run.status === "FAILED") {
          const result = await loadResult(transaction, run);
          if (result === null) throw new Error(`Terminal Forecast Run ${run.id} has no result`);
          return { run: await asForecastRun(transaction, run), result, accepted: false } as const;
        }
        const [resultRow] = await transaction.insert(forecastRunResults).values({ tenantId: request.tenantId, projectId: request.projectId, scenarioId: request.scenarioId, forecastRunId: request.forecastRunId, status: "FAILED", algorithmVersion, output, actorType: request.actor.type, actorId: request.actor.id }).returning();
        if (resultRow === undefined) throw new Error("Forecast failure result was not saved");
        const [updated] = await transaction.update(forecastRuns).set({ status: "FAILED", latestResultId: resultRow.id, startedAt: sql`coalesce(${forecastRuns.startedAt}, now())`, completedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(forecastRuns.tenantId, request.tenantId), eq(forecastRuns.projectId, request.projectId), eq(forecastRuns.scenarioId, request.scenarioId), eq(forecastRuns.id, request.forecastRunId), eq(forecastRuns.status, run.status))).returning();
        if (updated === undefined) throw new ForecastRunTransitionError(run.status, "FAILED");
        await appendAudit(transaction, request, request.actor, "forecast_run.completed", { status: "FAILED", resultId: resultRow.id });
        return { run: await asForecastRun(transaction, updated), result: asResult(resultRow), accepted: true } as const;
      }
      const revisions = await lockSources(transaction, request);
      const run = await lockRun(transaction, request);
      if (run.status === "READY" || run.status === "FAILED") {
        const result = await loadResult(transaction, run);
        if (result === null) throw new Error(`Terminal Forecast Run ${run.id} has no result`);
        return { run: await asForecastRun(transaction, run), result, accepted: false } as const;
      }
      if (run.status !== "RUNNING") throw new ForecastRunTransitionError(run.status, request.status);
      requireCurrent(run, revisions);
      const [resultRow] = await transaction.insert(forecastRunResults).values({ tenantId: request.tenantId, projectId: request.projectId, scenarioId: request.scenarioId, forecastRunId: request.forecastRunId, status: request.status, algorithmVersion, output, actorType: request.actor.type, actorId: request.actor.id }).returning();
      if (resultRow === undefined) throw new Error("Forecast result was not saved");
      const [updated] = await transaction.update(forecastRuns).set({ status: request.status, latestResultId: resultRow.id, completedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(forecastRuns.tenantId, request.tenantId), eq(forecastRuns.projectId, request.projectId), eq(forecastRuns.scenarioId, request.scenarioId), eq(forecastRuns.id, request.forecastRunId), eq(forecastRuns.status, "RUNNING"))).returning();
      if (updated === undefined) throw new ForecastRunTransitionError(run.status, request.status);
      await appendAudit(transaction, request, request.actor, "forecast_run.completed", { status: request.status, resultId: resultRow.id });
      return { run: await asForecastRun(transaction, updated), result: asResult(resultRow), accepted: true } as const;
    });
  }

  async listAuditEvents(tenantId: string, projectId: string, scenarioId: string, forecastRunId: string): Promise<readonly ForecastRunAuditEvent[]> {
    const rows = await this.database.select().from(forecastRunAuditEvents).where(and(eq(forecastRunAuditEvents.tenantId, tenantId), eq(forecastRunAuditEvents.projectId, projectId), eq(forecastRunAuditEvents.scenarioId, scenarioId), eq(forecastRunAuditEvents.forecastRunId, forecastRunId))).orderBy(asc(forecastRunAuditEvents.sequence));
    return rows.map((row) => ({ sequence: row.sequence, id: row.id, tenantId: row.tenantId, projectId: row.projectId, scenarioId: row.scenarioId, forecastRunId: row.forecastRunId, actor: { type: row.actorType, id: row.actorId }, eventType: row.eventType, payload: row.payload as ForecastJson, occurredAt: row.occurredAt }));
  }
}
