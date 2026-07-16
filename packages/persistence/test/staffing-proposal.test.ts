import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  ProjectRepository,
  ProjectScenarioRepository,
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

    const first = await repository.completeReadyWithScenario({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      algorithmVersion: "cp-sat-v1",
      output: { assignments: [{ taskId: "task-1", resourceId: "resource-1" }] },
      scenarioName: "Recover delivery candidate",
      changes: [],
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
        { eventType: "staffing_proposal.scenario_linked", payload: { scenarioId: first.proposal.linkedScenarioId } },
      ]);
  });

  it("completes a READY Proposal with its same-revision DRAFT Scenario already linked", async () => {
    const created = (await createProposal()).proposal;
    const request = {
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      algorithmVersion: "cp-sat-v1",
      output: { changes: [] },
      scenarioName: "Approved staffing candidate",
      changes: [] as const,
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    } as const;

    const completed = await repository.completeReadyWithScenario(request);

    expect(completed).toMatchObject({
      accepted: true,
      proposal: { status: "READY", linkedScenarioId: expect.any(String) },
      run: { status: "READY", algorithmVersion: "cp-sat-v1" },
    });
    const scenario = await new ProjectScenarioRepository(database).load(
      created.tenantId,
      created.projectId,
      completed.proposal.linkedScenarioId!,
    );
    expect(scenario).toMatchObject({
      status: "DRAFT",
      baseProjectRevision: created.baseProjectRevision,
      changes: [],
    });
    await expect(repository.completeReadyWithScenario(request)).resolves.toEqual({
      proposal: completed.proposal,
      run: completed.run,
      accepted: false,
    });
    await expect(new ProjectScenarioRepository(database).list(created.tenantId, created.projectId))
      .resolves.toEqual([scenario]);
  });

  it("does not expose READY completion without an atomically linked Scenario", async () => {
    const created = (await createProposal()).proposal;

    await expect(repository.complete({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      status: "READY" as never,
      algorithmVersion: "cp-sat-v1",
      output: { changes: [] },
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    })).rejects.toThrow("completeReadyWithScenario");
    await expect(repository.load(created.tenantId, created.projectId, created.id))
      .resolves.toMatchObject({ status: "REQUESTED", latestRun: null, linkedScenarioId: null });
  });

  it("rolls back the READY Run when its Scenario cannot be created", async () => {
    const created = (await createProposal()).proposal;

    await expect(repository.completeReadyWithScenario({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      algorithmVersion: "cp-sat-v1",
      output: { changes: [] },
      scenarioName: " ",
      changes: [],
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    })).rejects.toThrow("Scenario name");
    await expect(repository.load(
      created.tenantId,
      created.projectId,
      created.id,
    )).resolves.toMatchObject({ status: "REQUESTED", latestRun: null, linkedScenarioId: null });
    await expect(new ProjectScenarioRepository(database).list(created.tenantId, created.projectId))
      .resolves.toEqual([]);
    await expect(repository.listAuditEvents(
      created.tenantId,
      created.projectId,
      created.id,
    )).resolves.toMatchObject([{ eventType: "staffing_proposal.created" }]);
  });

  it("can terminalize a RUNNING Proposal after READY persistence detects a stale Project", async () => {
    const created = (await createProposal()).proposal;
    await repository.markRunning({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    });
    await client.query("update projects set revision = 2 where id = $1", [created.projectId]);

    await expect(repository.completeReadyWithScenario({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      algorithmVersion: "cp-sat-v1",
      output: { changes: [] },
      scenarioName: "Stale candidate",
      changes: [],
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    })).rejects.toBeInstanceOf(StaffingProposalStaleError);

    const failed = await repository.complete({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      status: "FAILED",
      algorithmVersion: "cp-sat-v1",
      output: {
        code: "PROJECT_REVISION_STALE",
        message: "Staffing Proposal became stale before its result was saved",
      },
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    });

    expect(failed).toMatchObject({
      accepted: true,
      proposal: { status: "FAILED", linkedScenarioId: null },
      run: { status: "FAILED", output: { code: "PROJECT_REVISION_STALE" } },
    });
    await expect(repository.complete({
      tenantId: created.tenantId,
      projectId: created.projectId,
      proposalId: created.id,
      status: "FAILED",
      algorithmVersion: "cp-sat-v1",
      output: { code: "PROJECT_REVISION_STALE" },
      actor: { type: "SYSTEM", id: "staffing-workflow" },
    })).resolves.toEqual({ proposal: failed.proposal, run: failed.run, accepted: false });
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
