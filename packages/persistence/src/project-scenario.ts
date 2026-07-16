import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  projects,
  scenarioAuditEvents,
  scenarioRuns,
  scenarios,
  schema,
} from "./schema.js";

export type ScenarioJson =
  | null
  | boolean
  | number
  | string
  | readonly ScenarioJson[]
  | { readonly [key: string]: ScenarioJson };

export type ScenarioPlanChange = {
  readonly type: string;
  readonly [key: string]: ScenarioJson;
};

export interface ScenarioActor {
  readonly type: "HUMAN" | "AGENT" | "SYSTEM";
  readonly id: string;
}

export interface ScenarioRun {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly scenarioId: string;
  readonly sourceProjectRevision: bigint;
  readonly sourceScenarioRevision: bigint;
  readonly algorithmVersion: string;
  readonly inputHash: string;
  readonly inputSnapshot: ScenarioJson;
  readonly output: ScenarioJson;
  readonly actor: ScenarioActor;
  readonly createdAt: string;
}

export interface ProjectScenario {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly status: "DRAFT" | "PUBLISHED" | "DISCARDED";
  readonly baseProjectRevision: bigint;
  readonly revision: bigint;
  readonly changes: readonly ScenarioPlanChange[];
  readonly latestRun: ScenarioRun | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly publishedBy: string | null;
  readonly publishedAt: string | null;
  readonly discardedBy: string | null;
  readonly discardedAt: string | null;
}

export interface ScenarioAuditEvent {
  readonly sequence: bigint;
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: bigint;
  readonly actor: ScenarioActor;
  readonly eventType: string;
  readonly payload: ScenarioJson;
  readonly occurredAt: string;
}

export class ScenarioNotFoundError extends Error {
  constructor(readonly scenarioId: string) {
    super(`Scenario ${scenarioId} was not found`);
    this.name = "ScenarioNotFoundError";
  }
}

export class ScenarioRevisionConflictError extends Error {
  constructor(readonly expectedRevision: bigint, readonly actualRevision: bigint) {
    super(`Scenario revision ${expectedRevision} does not match ${actualRevision}`);
    this.name = "ScenarioRevisionConflictError";
  }
}

export class ScenarioStaleError extends Error {
  constructor(readonly baseProjectRevision: bigint, readonly currentProjectRevision: bigint) {
    super(`Scenario is based on Project revision ${baseProjectRevision}, not ${currentProjectRevision}`);
    this.name = "ScenarioStaleError";
  }
}

export class ScenarioTerminalError extends Error {
  constructor(readonly status: "PUBLISHED" | "DISCARDED") {
    super(`${status} scenarios are terminal`);
    this.name = "ScenarioTerminalError";
  }
}

export class ScenarioRunRequiredError extends Error {
  constructor() {
    super("Publishing requires a latest run for the current Scenario revision");
    this.name = "ScenarioRunRequiredError";
  }
}

export type ScenarioTransaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

interface ScenarioIdentity {
  readonly tenantId: string;
  readonly projectId: string;
  readonly scenarioId: string;
}

function assertActor(actor: ScenarioActor): void {
  if (actor.id.trim().length === 0) throw new Error("Scenario actor ID must not be blank");
}

function assertJson(value: unknown, path = "value"): asserts value is ScenarioJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJson(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) throw new Error(`${path}.${key} must not be undefined`);
      assertJson(entry, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} must be JSON-safe`);
}

function assertChanges(changes: readonly ScenarioPlanChange[]): void {
  assertJson(changes, "Scenario changes");
  for (const change of changes) {
    if (change.type.trim().length === 0) throw new Error("Scenario change type must not be blank");
  }
}

function asRun(row: typeof scenarioRuns.$inferSelect): ScenarioRun {
  return {
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    scenarioId: row.scenarioId,
    sourceProjectRevision: row.sourceProjectRevision,
    sourceScenarioRevision: row.sourceScenarioRevision,
    algorithmVersion: row.algorithmVersion,
    inputHash: row.inputHash,
    inputSnapshot: row.inputSnapshot as ScenarioJson,
    output: row.output as ScenarioJson,
    actor: { type: row.actorType, id: row.actorId },
    createdAt: row.createdAt,
  };
}

async function loadRun(
  database: NodePgDatabase<typeof schema> | ScenarioTransaction,
  tenantId: string,
  projectId: string,
  scenarioId: string,
  runId: string | null,
): Promise<ScenarioRun | null> {
  if (runId === null) return null;
  const [row] = await database
    .select()
    .from(scenarioRuns)
    .where(and(
      eq(scenarioRuns.tenantId, tenantId),
      eq(scenarioRuns.projectId, projectId),
      eq(scenarioRuns.scenarioId, scenarioId),
      eq(scenarioRuns.id, runId),
    ))
    .limit(1);
  return row === undefined ? null : asRun(row);
}

async function asScenario(
  database: NodePgDatabase<typeof schema> | ScenarioTransaction,
  row: typeof scenarios.$inferSelect,
): Promise<ProjectScenario> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    baseProjectRevision: row.baseProjectRevision,
    revision: row.revision,
    changes: row.changes as readonly ScenarioPlanChange[],
    latestRun: await loadRun(database, row.tenantId, row.projectId, row.id, row.latestRunId),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
    discardedBy: row.discardedBy,
    discardedAt: row.discardedAt,
  };
}

async function lockProject(
  transaction: ScenarioTransaction,
  tenantId: string,
  projectId: string,
): Promise<bigint> {
  const [project] = await transaction
    .select({ revision: projects.revision })
    .from(projects)
    .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
    .for("update")
    .limit(1);
  if (project === undefined) throw new Error(`Project ${projectId} was not found`);
  return project.revision;
}

async function lockScenario(
  transaction: ScenarioTransaction,
  identity: ScenarioIdentity,
): Promise<typeof scenarios.$inferSelect> {
  const [scenario] = await transaction
    .select()
    .from(scenarios)
    .where(and(
      eq(scenarios.tenantId, identity.tenantId),
      eq(scenarios.projectId, identity.projectId),
      eq(scenarios.id, identity.scenarioId),
    ))
    .for("update")
    .limit(1);
  if (scenario === undefined) throw new ScenarioNotFoundError(identity.scenarioId);
  return scenario;
}

function requireDraft(scenario: typeof scenarios.$inferSelect): void {
  if (scenario.status !== "DRAFT") throw new ScenarioTerminalError(scenario.status);
}

function requireRevision(actual: bigint, expected: bigint): void {
  if (actual !== expected) throw new ScenarioRevisionConflictError(expected, actual);
}

function requireCurrentProject(base: bigint, current: bigint): void {
  if (base !== current) throw new ScenarioStaleError(base, current);
}

async function appendAudit(
  transaction: ScenarioTransaction,
  scenario: ScenarioIdentity,
  scenarioRevision: bigint,
  actor: ScenarioActor,
  eventType: string,
  payload: ScenarioJson,
): Promise<void> {
  await transaction.insert(scenarioAuditEvents).values({
    ...scenario,
    scenarioRevision,
    actorType: actor.type,
    actorId: actor.id,
    eventType,
    payload,
  });
}

export interface MarkScenarioPublishedRequest extends ScenarioIdentity {
  readonly expectedScenarioRevision: bigint;
  readonly sourceProjectRevision: bigint;
  readonly actor: ScenarioActor;
}

export interface CreateScenarioRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly baseProjectRevision: bigint;
  readonly changes: readonly ScenarioPlanChange[];
  readonly actor: ScenarioActor;
}

export async function createScenarioInTransaction(
  transaction: ScenarioTransaction,
  request: CreateScenarioRequest,
): Promise<ProjectScenario> {
  assertActor(request.actor);
  assertChanges(request.changes);
  const name = request.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new Error("Scenario name must contain 1 to 200 characters");
  }
  const projectRevision = await lockProject(
    transaction,
    request.tenantId,
    request.projectId,
  );
  requireCurrentProject(request.baseProjectRevision, projectRevision);
  const [created] = await transaction.insert(scenarios).values({
    tenantId: request.tenantId,
    projectId: request.projectId,
    name,
    baseProjectRevision: request.baseProjectRevision,
    changes: request.changes,
    createdBy: request.actor.id,
    updatedBy: request.actor.id,
  }).returning();
  if (created === undefined) throw new Error("Scenario was not created");
  const identity = {
    tenantId: created.tenantId,
    projectId: created.projectId,
    scenarioId: created.id,
  };
  await appendAudit(transaction, identity, created.revision, request.actor, "scenario.created", {
    name,
    baseProjectRevision: created.baseProjectRevision.toString(),
  });
  return asScenario(transaction, created);
}

export async function markScenarioPublished(
  transaction: ScenarioTransaction,
  request: MarkScenarioPublishedRequest,
): Promise<ProjectScenario> {
  assertActor(request.actor);
  const projectRevision = await lockProject(transaction, request.tenantId, request.projectId);
  const scenario = await lockScenario(transaction, request);
  requireDraft(scenario);
  requireRevision(scenario.revision, request.expectedScenarioRevision);
  requireCurrentProject(scenario.baseProjectRevision, projectRevision);
  requireCurrentProject(request.sourceProjectRevision, projectRevision);
  const latestRun = await loadRun(
    transaction,
    request.tenantId,
    request.projectId,
    request.scenarioId,
    scenario.latestRunId,
  );
  if (
    latestRun === null ||
    latestRun.sourceProjectRevision !== projectRevision ||
    latestRun.sourceScenarioRevision !== scenario.revision
  ) {
    throw new ScenarioRunRequiredError();
  }
  const revision = scenario.revision + 1n;
  const [updated] = await transaction
    .update(scenarios)
    .set({
      status: "PUBLISHED",
      revision,
      updatedBy: request.actor.id,
      updatedAt: sql`now()`,
      publishedBy: request.actor.id,
      publishedAt: sql`now()`,
    })
    .where(and(
      eq(scenarios.tenantId, request.tenantId),
      eq(scenarios.projectId, request.projectId),
      eq(scenarios.id, request.scenarioId),
    ))
    .returning();
  if (updated === undefined) throw new ScenarioNotFoundError(request.scenarioId);
  await appendAudit(transaction, request, revision, request.actor, "scenario.published", {
    runId: latestRun.id,
    sourceProjectRevision: projectRevision.toString(),
  });
  return asScenario(transaction, updated);
}

export class ProjectScenarioRepository {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async list(tenantId: string, projectId: string): Promise<readonly ProjectScenario[]> {
    const rows = await this.database
      .select()
      .from(scenarios)
      .where(and(eq(scenarios.tenantId, tenantId), eq(scenarios.projectId, projectId)))
      .orderBy(desc(scenarios.updatedAt), asc(scenarios.id));
    return Promise.all(rows.map((row) => asScenario(this.database, row)));
  }

  async load(tenantId: string, projectId: string, scenarioId: string): Promise<ProjectScenario | null> {
    const [row] = await this.database
      .select()
      .from(scenarios)
      .where(and(
        eq(scenarios.tenantId, tenantId),
        eq(scenarios.projectId, projectId),
        eq(scenarios.id, scenarioId),
      ))
      .limit(1);
    return row === undefined ? null : asScenario(this.database, row);
  }

  async create(request: CreateScenarioRequest): Promise<ProjectScenario> {
    return this.database.transaction((transaction) =>
      createScenarioInTransaction(transaction, request));
  }

  async updateChanges(request: ScenarioIdentity & {
    readonly expectedRevision: bigint;
    readonly changes: readonly ScenarioPlanChange[];
    readonly actor: ScenarioActor;
  }): Promise<ProjectScenario> {
    assertActor(request.actor);
    assertChanges(request.changes);
    return this.database.transaction(async (transaction) => {
      const projectRevision = await lockProject(transaction, request.tenantId, request.projectId);
      const scenario = await lockScenario(transaction, request);
      requireDraft(scenario);
      requireRevision(scenario.revision, request.expectedRevision);
      requireCurrentProject(scenario.baseProjectRevision, projectRevision);
      const revision = scenario.revision + 1n;
      const [updated] = await transaction.update(scenarios).set({
        changes: request.changes,
        revision,
        latestRunId: null,
        updatedBy: request.actor.id,
        updatedAt: sql`now()`,
      }).where(and(
        eq(scenarios.tenantId, request.tenantId),
        eq(scenarios.projectId, request.projectId),
        eq(scenarios.id, request.scenarioId),
      )).returning();
      if (updated === undefined) throw new ScenarioNotFoundError(request.scenarioId);
      await appendAudit(transaction, request, revision, request.actor, "scenario.changes_updated", {
        changeCount: request.changes.length,
      });
      return asScenario(transaction, updated);
    });
  }

  async saveRun(request: ScenarioIdentity & {
    readonly expectedScenarioRevision: bigint;
    readonly sourceProjectRevision: bigint;
    readonly algorithmVersion: string;
    readonly inputHash: string;
    readonly inputSnapshot: ScenarioJson;
    readonly output: ScenarioJson;
    readonly actor: ScenarioActor;
  }): Promise<ScenarioRun> {
    assertActor(request.actor);
    assertJson(request.inputSnapshot, "Scenario run input");
    assertJson(request.output, "Scenario run output");
    if (request.algorithmVersion.trim().length === 0 || request.algorithmVersion.length > 100) {
      throw new Error("Scenario algorithm version must contain 1 to 100 characters");
    }
    if (!/^[0-9a-f]{64}$/.test(request.inputHash)) throw new Error("Scenario input hash must be lowercase SHA-256 hex");
    return this.database.transaction(async (transaction) => {
      const projectRevision = await lockProject(transaction, request.tenantId, request.projectId);
      const scenario = await lockScenario(transaction, request);
      requireDraft(scenario);
      requireRevision(scenario.revision, request.expectedScenarioRevision);
      requireCurrentProject(scenario.baseProjectRevision, projectRevision);
      requireCurrentProject(request.sourceProjectRevision, projectRevision);
      const [created] = await transaction.insert(scenarioRuns).values({
        tenantId: request.tenantId,
        projectId: request.projectId,
        scenarioId: request.scenarioId,
        sourceProjectRevision: request.sourceProjectRevision,
        sourceScenarioRevision: scenario.revision,
        algorithmVersion: request.algorithmVersion.trim(),
        inputHash: request.inputHash,
        inputSnapshot: request.inputSnapshot,
        output: request.output,
        actorType: request.actor.type,
        actorId: request.actor.id,
      }).returning();
      if (created === undefined) throw new Error("Scenario run was not saved");
      await transaction.update(scenarios).set({
        latestRunId: created.id,
        updatedBy: request.actor.id,
        updatedAt: sql`now()`,
      }).where(and(
        eq(scenarios.tenantId, request.tenantId),
        eq(scenarios.projectId, request.projectId),
        eq(scenarios.id, request.scenarioId),
      ));
      await appendAudit(transaction, request, scenario.revision, request.actor, "scenario.run_saved", {
        runId: created.id,
        algorithmVersion: created.algorithmVersion,
        inputHash: created.inputHash,
      });
      return asRun(created);
    });
  }

  async discard(request: ScenarioIdentity & {
    readonly expectedRevision: bigint;
    readonly actor: ScenarioActor;
  }): Promise<ProjectScenario> {
    assertActor(request.actor);
    return this.database.transaction(async (transaction) => {
      await lockProject(transaction, request.tenantId, request.projectId);
      const scenario = await lockScenario(transaction, request);
      requireDraft(scenario);
      requireRevision(scenario.revision, request.expectedRevision);
      const revision = scenario.revision + 1n;
      const [updated] = await transaction.update(scenarios).set({
        status: "DISCARDED",
        revision,
        updatedBy: request.actor.id,
        updatedAt: sql`now()`,
        discardedBy: request.actor.id,
        discardedAt: sql`now()`,
      }).where(and(
        eq(scenarios.tenantId, request.tenantId),
        eq(scenarios.projectId, request.projectId),
        eq(scenarios.id, request.scenarioId),
      )).returning();
      if (updated === undefined) throw new ScenarioNotFoundError(request.scenarioId);
      await appendAudit(transaction, request, revision, request.actor, "scenario.discarded", {});
      return asScenario(transaction, updated);
    });
  }

  async listAuditEvents(
    tenantId: string,
    projectId: string,
    scenarioId: string,
  ): Promise<readonly ScenarioAuditEvent[]> {
    const rows = await this.database.select().from(scenarioAuditEvents).where(and(
      eq(scenarioAuditEvents.tenantId, tenantId),
      eq(scenarioAuditEvents.projectId, projectId),
      eq(scenarioAuditEvents.scenarioId, scenarioId),
    )).orderBy(asc(scenarioAuditEvents.sequence));
    return rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      tenantId: row.tenantId,
      projectId: row.projectId,
      scenarioId: row.scenarioId,
      scenarioRevision: row.scenarioRevision,
      actor: { type: row.actorType, id: row.actorId },
      eventType: row.eventType,
      payload: row.payload as ScenarioJson,
      occurredAt: row.occurredAt,
    }));
  }
}
