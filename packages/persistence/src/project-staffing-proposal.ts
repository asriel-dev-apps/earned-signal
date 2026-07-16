import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createScenarioInTransaction,
  type ScenarioPlanChange,
  type ScenarioTransaction,
} from "./project-scenario.js";
import {
  projects,
  schema,
  staffingProposalAuditEvents,
  staffingProposalRuns,
  staffingProposals,
} from "./schema.js";

export type StaffingProposalJson =
  | null
  | boolean
  | number
  | string
  | readonly StaffingProposalJson[]
  | { readonly [key: string]: StaffingProposalJson };

export interface StaffingProposalActor {
  readonly type: "HUMAN" | "AGENT" | "SYSTEM";
  readonly id: string;
}

export type StaffingProposalTerminalStatus =
  | "READY"
  | "INFEASIBLE"
  | "UNKNOWN"
  | "FAILED";

export interface StaffingProposalRun {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly status: StaffingProposalTerminalStatus;
  readonly algorithmVersion: string;
  readonly output: StaffingProposalJson;
  readonly actor: StaffingProposalActor;
  readonly createdAt: string;
}

export interface StaffingProposal {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly status:
    | "REQUESTED"
    | "RUNNING"
    | StaffingProposalTerminalStatus;
  readonly baseProjectRevision: bigint;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly input: StaffingProposalJson;
  readonly latestRun: StaffingProposalRun | null;
  readonly linkedScenarioId: string | null;
  readonly createdBy: StaffingProposalActor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface StaffingProposalAuditEvent {
  readonly sequence: bigint;
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly actor: StaffingProposalActor;
  readonly eventType: string;
  readonly payload: StaffingProposalJson;
  readonly occurredAt: string;
}

export class StaffingProposalNotFoundError extends Error {
  constructor(readonly proposalId: string) {
    super(`Staffing Proposal ${proposalId} was not found`);
    this.name = "StaffingProposalNotFoundError";
  }
}

export class StaffingProposalIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} represents a different Staffing Proposal request`);
    this.name = "StaffingProposalIdempotencyConflictError";
  }
}

export class StaffingProposalStaleError extends Error {
  constructor(readonly baseProjectRevision: bigint, readonly currentProjectRevision: bigint) {
    super(`Staffing Proposal is based on Project revision ${baseProjectRevision}, not ${currentProjectRevision}`);
    this.name = "StaffingProposalStaleError";
  }
}

export class StaffingProposalTransitionError extends Error {
  constructor(
    readonly currentStatus: StaffingProposal["status"],
    readonly requestedStatus: StaffingProposal["status"] | "LINKED",
  ) {
    super(`Staffing Proposal cannot transition from ${currentStatus} to ${requestedStatus}`);
    this.name = "StaffingProposalTransitionError";
  }
}

interface StaffingProposalIdentity {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proposalId: string;
}

export interface CreateStaffingProposalRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly baseProjectRevision: bigint;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly input: StaffingProposalJson;
  readonly actor: StaffingProposalActor;
}

export interface LinkStaffingProposalScenarioRequest extends StaffingProposalIdentity {
  readonly scenarioName: string;
  readonly changes: readonly ScenarioPlanChange[];
  readonly actor: StaffingProposalActor;
}

export type StaffingProposalTransaction = ScenarioTransaction;

const TERMINAL_STATUSES = new Set<StaffingProposal["status"]>([
  "READY",
  "INFEASIBLE",
  "UNKNOWN",
  "FAILED",
]);

function assertActor(actor: StaffingProposalActor): void {
  if (actor.id.trim().length === 0) {
    throw new Error("Staffing Proposal actor ID must not be blank");
  }
}

function assertJson(value: unknown, path = "value"): asserts value is StaffingProposalJson {
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

function assertHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("Staffing Proposal request hash must be lowercase SHA-256 hex");
  }
}

function asRun(row: typeof staffingProposalRuns.$inferSelect): StaffingProposalRun {
  if (!TERMINAL_STATUSES.has(row.status)) {
    throw new Error(`Staffing Proposal Run has non-terminal status ${row.status}`);
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    proposalId: row.proposalId,
    status: row.status as StaffingProposalTerminalStatus,
    algorithmVersion: row.algorithmVersion,
    output: row.output as StaffingProposalJson,
    actor: { type: row.actorType, id: row.actorId },
    createdAt: row.createdAt,
  };
}

async function loadRun(
  database: NodePgDatabase<typeof schema> | StaffingProposalTransaction,
  row: typeof staffingProposals.$inferSelect,
): Promise<StaffingProposalRun | null> {
  if (row.latestRunId === null) return null;
  const [run] = await database.select().from(staffingProposalRuns).where(and(
    eq(staffingProposalRuns.tenantId, row.tenantId),
    eq(staffingProposalRuns.projectId, row.projectId),
    eq(staffingProposalRuns.proposalId, row.id),
    eq(staffingProposalRuns.id, row.latestRunId),
  )).limit(1);
  if (run === undefined) {
    throw new Error(`Staffing Proposal ${row.id} references a missing Run`);
  }
  return asRun(run);
}

async function asProposal(
  database: NodePgDatabase<typeof schema> | StaffingProposalTransaction,
  row: typeof staffingProposals.$inferSelect,
): Promise<StaffingProposal> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    baseProjectRevision: row.baseProjectRevision,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    input: row.input as StaffingProposalJson,
    latestRun: await loadRun(database, row),
    linkedScenarioId: row.linkedScenarioId,
    createdBy: { type: row.createdByType, id: row.createdBy },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

async function lockProject(
  transaction: StaffingProposalTransaction,
  tenantId: string,
  projectId: string,
): Promise<bigint> {
  const [project] = await transaction.select({ revision: projects.revision }).from(projects)
    .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
    .for("update")
    .limit(1);
  if (project === undefined) throw new Error(`Project ${projectId} was not found`);
  return project.revision;
}

async function lockProposal(
  transaction: StaffingProposalTransaction,
  identity: StaffingProposalIdentity,
): Promise<typeof staffingProposals.$inferSelect> {
  const [proposal] = await transaction.select().from(staffingProposals).where(and(
    eq(staffingProposals.tenantId, identity.tenantId),
    eq(staffingProposals.projectId, identity.projectId),
    eq(staffingProposals.id, identity.proposalId),
  )).for("update").limit(1);
  if (proposal === undefined) throw new StaffingProposalNotFoundError(identity.proposalId);
  return proposal;
}

async function appendAudit(
  transaction: StaffingProposalTransaction,
  identity: StaffingProposalIdentity,
  actor: StaffingProposalActor,
  eventType: string,
  payload: StaffingProposalJson,
): Promise<void> {
  await transaction.insert(staffingProposalAuditEvents).values({
    ...identity,
    actorType: actor.type,
    actorId: actor.id,
    eventType,
    payload,
  });
}

export async function linkStaffingProposalScenario(
  transaction: StaffingProposalTransaction,
  request: LinkStaffingProposalScenarioRequest,
): Promise<StaffingProposal> {
  assertActor(request.actor);
  const projectRevision = await lockProject(transaction, request.tenantId, request.projectId);
  const proposal = await lockProposal(transaction, request);
  if (proposal.status !== "READY" || proposal.linkedScenarioId !== null) {
    throw new StaffingProposalTransitionError(proposal.status, "LINKED");
  }
  if (proposal.baseProjectRevision !== projectRevision) {
    throw new StaffingProposalStaleError(proposal.baseProjectRevision, projectRevision);
  }
  const scenario = await createScenarioInTransaction(transaction, {
    tenantId: request.tenantId,
    projectId: request.projectId,
    name: request.scenarioName,
    baseProjectRevision: proposal.baseProjectRevision,
    changes: request.changes,
    actor: request.actor,
  });
  const [updated] = await transaction.update(staffingProposals).set({
    linkedScenarioId: scenario.id,
    updatedAt: sql`now()`,
  }).where(and(
    eq(staffingProposals.tenantId, request.tenantId),
    eq(staffingProposals.projectId, request.projectId),
    eq(staffingProposals.id, request.proposalId),
    eq(staffingProposals.status, "READY"),
  )).returning();
  if (updated === undefined) throw new StaffingProposalNotFoundError(request.proposalId);
  await appendAudit(transaction, request, request.actor, "staffing_proposal.scenario_linked", {
    scenarioId: scenario.id,
  });
  return asProposal(transaction, updated);
}

export class ProjectStaffingProposalRepository {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async create(request: CreateStaffingProposalRequest): Promise<{
    readonly proposal: StaffingProposal;
    readonly replayed: boolean;
  }> {
    assertActor(request.actor);
    assertJson(request.input, "Staffing Proposal input");
    assertHash(request.requestHash);
    const name = request.name.trim();
    const idempotencyKey = request.idempotencyKey.trim();
    if (name.length === 0 || name.length > 200) {
      throw new Error("Staffing Proposal name must contain 1 to 200 characters");
    }
    if (idempotencyKey.length === 0 || idempotencyKey.length > 200) {
      throw new Error("Staffing Proposal idempotency key must contain 1 to 200 characters");
    }
    return this.database.transaction(async (transaction) => {
      const findExisting = () => transaction.select().from(staffingProposals).where(and(
        eq(staffingProposals.tenantId, request.tenantId),
        eq(staffingProposals.projectId, request.projectId),
        eq(staffingProposals.idempotencyKey, idempotencyKey),
      )).limit(1);
      const replay = async (existing: typeof staffingProposals.$inferSelect) => {
        if (existing.requestHash !== request.requestHash) {
          throw new StaffingProposalIdempotencyConflictError(idempotencyKey);
        }
        return { proposal: await asProposal(transaction, existing), replayed: true } as const;
      };

      const [existing] = await findExisting();
      if (existing !== undefined) return replay(existing);
      const projectRevision = await lockProject(transaction, request.tenantId, request.projectId);
      const [concurrent] = await findExisting();
      if (concurrent !== undefined) return replay(concurrent);
      if (request.baseProjectRevision !== projectRevision) {
        throw new StaffingProposalStaleError(request.baseProjectRevision, projectRevision);
      }
      const [created] = await transaction.insert(staffingProposals).values({
        tenantId: request.tenantId,
        projectId: request.projectId,
        name,
        baseProjectRevision: request.baseProjectRevision,
        idempotencyKey,
        requestHash: request.requestHash,
        input: request.input,
        createdByType: request.actor.type,
        createdBy: request.actor.id,
      }).returning();
      if (created === undefined) throw new Error("Staffing Proposal was not created");
      const identity = {
        tenantId: created.tenantId,
        projectId: created.projectId,
        proposalId: created.id,
      };
      await appendAudit(transaction, identity, request.actor, "staffing_proposal.created", {
        baseProjectRevision: created.baseProjectRevision.toString(),
        requestHash: created.requestHash,
      });
      return { proposal: await asProposal(transaction, created), replayed: false } as const;
    });
  }

  async list(tenantId: string, projectId: string): Promise<readonly StaffingProposal[]> {
    const rows = await this.database.select().from(staffingProposals).where(and(
      eq(staffingProposals.tenantId, tenantId),
      eq(staffingProposals.projectId, projectId),
    )).orderBy(desc(staffingProposals.createdAt), asc(staffingProposals.id));
    return Promise.all(rows.map((row) => asProposal(this.database, row)));
  }

  async load(
    tenantId: string,
    projectId: string,
    proposalId: string,
  ): Promise<StaffingProposal | null> {
    const [row] = await this.database.select().from(staffingProposals).where(and(
      eq(staffingProposals.tenantId, tenantId),
      eq(staffingProposals.projectId, projectId),
      eq(staffingProposals.id, proposalId),
    )).limit(1);
    return row === undefined ? null : asProposal(this.database, row);
  }

  async markRunning(request: StaffingProposalIdentity & {
    readonly actor: StaffingProposalActor;
  }): Promise<StaffingProposal> {
    assertActor(request.actor);
    return this.database.transaction(async (transaction) => {
      const proposal = await lockProposal(transaction, request);
      if (proposal.status !== "REQUESTED") {
        throw new StaffingProposalTransitionError(proposal.status, "RUNNING");
      }
      const [updated] = await transaction.update(staffingProposals).set({
        status: "RUNNING",
        startedAt: sql`now()`,
        updatedAt: sql`now()`,
      }).where(and(
        eq(staffingProposals.tenantId, request.tenantId),
        eq(staffingProposals.projectId, request.projectId),
        eq(staffingProposals.id, request.proposalId),
        eq(staffingProposals.status, "REQUESTED"),
      )).returning();
      if (updated === undefined) throw new StaffingProposalNotFoundError(request.proposalId);
      await appendAudit(transaction, request, request.actor, "staffing_proposal.running", {});
      return asProposal(transaction, updated);
    });
  }

  async complete(request: StaffingProposalIdentity & {
    readonly status: StaffingProposalTerminalStatus;
    readonly algorithmVersion: string;
    readonly output: StaffingProposalJson;
    readonly actor: StaffingProposalActor;
  }): Promise<{
    readonly proposal: StaffingProposal;
    readonly run: StaffingProposalRun;
    readonly accepted: boolean;
  }> {
    assertActor(request.actor);
    assertJson(request.output, "Staffing Proposal output");
    const algorithmVersion = request.algorithmVersion.trim();
    if (algorithmVersion.length === 0 || algorithmVersion.length > 100) {
      throw new Error("Staffing Proposal algorithm version must contain 1 to 100 characters");
    }
    return this.database.transaction(async (transaction) => {
      const proposal = await lockProposal(transaction, request);
      if (TERMINAL_STATUSES.has(proposal.status)) {
        const run = await loadRun(transaction, proposal);
        if (run === null) throw new Error(`Terminal Staffing Proposal ${proposal.id} has no Run`);
        return { proposal: await asProposal(transaction, proposal), run, accepted: false } as const;
      }
      if (proposal.status !== "REQUESTED" && proposal.status !== "RUNNING") {
        throw new StaffingProposalTransitionError(proposal.status, request.status);
      }
      const [runRow] = await transaction.insert(staffingProposalRuns).values({
        tenantId: request.tenantId,
        projectId: request.projectId,
        proposalId: request.proposalId,
        status: request.status,
        algorithmVersion,
        output: request.output,
        actorType: request.actor.type,
        actorId: request.actor.id,
      }).returning();
      if (runRow === undefined) throw new Error("Staffing Proposal Run was not saved");
      const [updated] = await transaction.update(staffingProposals).set({
        status: request.status,
        latestRunId: runRow.id,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      }).where(and(
        eq(staffingProposals.tenantId, request.tenantId),
        eq(staffingProposals.projectId, request.projectId),
        eq(staffingProposals.id, request.proposalId),
        eq(staffingProposals.status, proposal.status),
      )).returning();
      if (updated === undefined) throw new StaffingProposalTransitionError(proposal.status, request.status);
      await appendAudit(transaction, request, request.actor, "staffing_proposal.completed", {
        status: request.status,
        runId: runRow.id,
      });
      return {
        proposal: await asProposal(transaction, updated),
        run: asRun(runRow),
        accepted: true,
      } as const;
    });
  }

  async linkScenario(request: LinkStaffingProposalScenarioRequest): Promise<StaffingProposal> {
    return this.database.transaction((transaction) =>
      linkStaffingProposalScenario(transaction, request));
  }

  async listAuditEvents(
    tenantId: string,
    projectId: string,
    proposalId: string,
  ): Promise<readonly StaffingProposalAuditEvent[]> {
    const rows = await this.database.select().from(staffingProposalAuditEvents).where(and(
      eq(staffingProposalAuditEvents.tenantId, tenantId),
      eq(staffingProposalAuditEvents.projectId, projectId),
      eq(staffingProposalAuditEvents.proposalId, proposalId),
    )).orderBy(asc(staffingProposalAuditEvents.sequence));
    return rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      tenantId: row.tenantId,
      projectId: row.projectId,
      proposalId: row.proposalId,
      actor: { type: row.actorType, id: row.actorId },
      eventType: row.eventType,
      payload: row.payload as StaffingProposalJson,
      occurredAt: row.occurredAt,
    }));
  }
}
