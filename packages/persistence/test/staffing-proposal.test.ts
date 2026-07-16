import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  linkStaffingProposalScenario,
  migratePersistenceDatabase,
  ProjectRepository,
  ProjectStaffingProposalRepository,
  StaffingProposalIdempotencyConflictError,
  StaffingProposalStaleError,
  StaffingProposalTransitionError,
} from "../src/index.js";

describe("ProjectStaffingProposalRepository", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  const actor = { type: "HUMAN" as const, id: "planner-001" };
  const input = {
    constraints: [{ id: "skill-backend", kind: "SKILL", hardness: "HARD" }],
    objective: ["DEADLINE", "OVERTIME", "COST", "CHANGE"],
  } as const;
  let client: Client;
  let database: ReturnType<typeof createPersistenceDatabase>;
  let repository: ProjectStaffingProposalRepository;
  let projectRepository: ProjectRepository;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    database = createPersistenceDatabase(client);
    repository = new ProjectStaffingProposalRepository(database);
    projectRepository = new ProjectRepository(database);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await stopContainer?.();
  });

  beforeEach(async () => {
    await client.query("truncate table tenants cascade");
    await projectRepository.save(demoProjectRecord);
  });

  async function createProposal(idempotencyKey = "staffing-proposal-1", requestHash = "a".repeat(64)) {
    return repository.create({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      name: "Recover delivery",
      baseProjectRevision: 1n,
      idempotencyKey,
      requestHash,
      input,
      actor,
    });
  }

  it("creates, replays, lists, and loads a tenant-scoped immutable request", async () => {
    const created = await createProposal();
    const replay = await createProposal();

    expect(created).toMatchObject({
      replayed: false,
      proposal: {
        name: "Recover delivery",
        status: "REQUESTED",
        baseProjectRevision: 1n,
        requestHash: "a".repeat(64),
        input,
        latestRun: null,
        linkedScenarioId: null,
      },
    });
    expect(replay).toEqual({ proposal: created.proposal, replayed: true });
    await expect(repository.load(
      created.proposal.tenantId,
      created.proposal.projectId,
      created.proposal.id,
    )).resolves.toEqual(created.proposal);
    await expect(repository.list(
      created.proposal.tenantId,
      created.proposal.projectId,
    )).resolves.toEqual([created.proposal]);
    await expect(repository.load(
      "00000000-0000-4000-8000-ffffffffffff",
      created.proposal.projectId,
      created.proposal.id,
    )).resolves.toBeNull();
    await expect(repository.listAuditEvents(
      created.proposal.tenantId,
      created.proposal.projectId,
      created.proposal.id,
    )).resolves.toMatchObject([
      { eventType: "staffing_proposal.created", actor },
    ]);

    await expect(createProposal("staffing-proposal-1", "b".repeat(64)))
      .rejects.toBeInstanceOf(StaffingProposalIdempotencyConflictError);
  });

  it("rejects a request based on a stale Project revision", async () => {
    await client.query("update projects set revision = 2 where id = $1", [demoProjectRecord.project.id]);

    await expect(createProposal("stale-proposal"))
      .rejects.toBeInstanceOf(StaffingProposalStaleError);
  });

  it("enforces the tenant and Project boundary on child records", async () => {
    const proposal = (await createProposal()).proposal;
    const tenantId = "00000000-0000-4000-8000-000000000099";
    const projectId = "10000000-0000-4000-8000-000000000099";
    await client.query("insert into tenants (id, name) values ($1, 'Other tenant')", [tenantId]);
    await client.query("begin");
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Other project', '2026-01-01', '2026-01-01')`,
      [projectId, tenantId],
    );
    await client.query(
      `insert into project_calendars
         (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
       values ($1, $2, 'standard', 'Standard', array[1,2,3,4,5], array[]::date[])`,
      [tenantId, projectId],
    );
    await client.query("commit");

    await expect(client.query(
      `insert into staffing_proposal_runs
         (tenant_id, project_id, proposal_id, status, algorithm_version, output, actor_type, actor_id)
       values ($1, $2, $3, 'FAILED', 'cp-sat-v1', '{}', 'SYSTEM', 'worker')`,
      [tenantId, projectId, proposal.id],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("allows only strict transitions and keeps the first terminal result", async () => {
    const created = (await createProposal()).proposal;
    const running = await repository.markRunning({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    });
    expect(running).toMatchObject({ status: "RUNNING" });
    expect(running.startedAt).not.toBeNull();

    const first = await repository.complete({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      status: "READY",
      algorithmVersion: "cp-sat-v1",
      output: { assignments: [{ taskId: "task-1", resourceId: "resource-1" }] },
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    });
    expect(first).toMatchObject({
      accepted: true,
      proposal: { status: "READY" },
      run: { status: "READY", algorithmVersion: "cp-sat-v1" },
    });

    const late = await repository.complete({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      status: "FAILED",
      algorithmVersion: "cp-sat-v1",
      output: { error: "late container failure" },
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    });
    expect(late).toEqual({ proposal: first.proposal, run: first.run, accepted: false });
    await expect(repository.markRunning({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    })).rejects.toBeInstanceOf(StaffingProposalTransitionError);
    await expect(repository.listAuditEvents(created.tenantId, created.projectId, created.id))
      .resolves.toMatchObject([
        { eventType: "staffing_proposal.created" },
        { eventType: "staffing_proposal.running" },
        { eventType: "staffing_proposal.completed", payload: { status: "READY", runId: first.run.id } },
      ]);
  });

  it("creates and links a Scenario atomically, and rolls the whole link back on failure", async () => {
    const completed = await repository.complete({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      proposalId: (await createProposal()).proposal.id,
      status: "READY",
      algorithmVersion: "cp-sat-v1",
      output: { changes: [] },
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    });
    const request = {
      tenantId: completed.proposal.tenantId,
      projectId: completed.proposal.projectId,
      proposalId: completed.proposal.id,
      scenarioName: "Approved staffing candidate",
      changes: [] as const,
      actor,
    };

    await expect(database.transaction(async (transaction) => {
      await linkStaffingProposalScenario(transaction, request);
      throw new Error("abort approval handoff");
    })).rejects.toThrow("abort approval handoff");
    await expect(repository.load(
      request.tenantId,
      request.projectId,
      request.proposalId,
    )).resolves.toMatchObject({ linkedScenarioId: null });
    const rolledBackScenarios = await client.query<{ count: string }>(
      "select count(*)::text as count from scenarios where tenant_id = $1 and project_id = $2",
      [request.tenantId, request.projectId],
    );
    expect(rolledBackScenarios.rows).toEqual([{ count: "0" }]);
    await expect(repository.listAuditEvents(
      request.tenantId,
      request.projectId,
      request.proposalId,
    )).resolves.not.toContainEqual(expect.objectContaining({
      eventType: "staffing_proposal.scenario_linked",
    }));

    const linked = await repository.linkScenario(request);
    expect(linked.linkedScenarioId).not.toBeNull();
    const scenarioRows = await client.query<{ base_project_revision: string }>(
      "select base_project_revision::text from scenarios where id = $1",
      [linked.linkedScenarioId],
    );
    expect(scenarioRows.rows).toEqual([{ base_project_revision: "1" }]);
  });

  it("keeps proposal inputs, runs, and audit events immutable in PostgreSQL", async () => {
    const completed = await repository.complete({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      proposalId: (await createProposal()).proposal.id,
      status: "INFEASIBLE",
      algorithmVersion: "cp-sat-v1",
      output: { conflictingConstraintIds: ["skill-backend"] },
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    });

    await expect(client.query(
      "update staffing_proposals set input = '{}' where id = $1",
      [completed.proposal.id],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(client.query(
      `update staffing_proposals
       set status = 'RUNNING', latest_run_id = null, completed_at = null, started_at = now()
       where id = $1`,
      [completed.proposal.id],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(client.query(
      "update staffing_proposal_runs set output = '{}' where id = $1",
      [completed.run.id],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(client.query(
      "delete from staffing_proposal_audit_events where proposal_id = $1",
      [completed.proposal.id],
    )).rejects.toMatchObject({ code: "55000" });
  });
});
