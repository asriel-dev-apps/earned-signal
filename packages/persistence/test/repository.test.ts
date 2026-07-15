import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  calculateProjectPerformance,
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  ProjectPerformanceRepository,
  ProjectRepository,
  ProjectWorkspaceRepository,
} from "../src/index.js";

describe("ProjectRepository", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let repository: ProjectRepository;
  let performanceRepository: ProjectPerformanceRepository;
  let workspaceRepository: ProjectWorkspaceRepository;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    const database = createPersistenceDatabase(client);
    repository = new ProjectRepository(database);
    performanceRepository = new ProjectPerformanceRepository(database);
    workspaceRepository = new ProjectWorkspaceRepository(database);
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  beforeEach(async () => {
    await client.query("truncate table tenants cascade");
    await repository.save(demoProjectRecord);
  });

  it("saves and reloads the tenant-scoped demo project and its frozen baseline", async () => {
    const loaded = await repository.load(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
    );

    expect(loaded).toEqual(demoProjectRecord);
    expect(loaded?.wbsNodes).toHaveLength(12);
    expect(loaded?.activities).toHaveLength(9);
    expect(loaded?.dependencies).toHaveLength(8);
    expect(loaded?.baseline?.activities).toHaveLength(9);
    expect(loaded?.baseline?.wbsNodes).toHaveLength(12);
    expect(loaded?.baseline?.dependencies).toHaveLength(8);
    expect(loaded?.baseline?.activities[0]).toMatchObject({
      baselineStart: "2026-07-13",
      baselineFinish: "2026-07-17",
      budgetMinor: 600_000n,
    });
    expect(loaded?.worklogs[0]?.actualMinutes).toBe(2_760);
    expect(loaded?.directActualCosts[0]?.amountMinor).toBe(650_000n);
    expect(loaded?.auditEvents).toEqual(demoProjectRecord.auditEvents);

    const nextAudit = await client.query<{ sequence: string }>(
      `insert into audit_events
         (tenant_id, project_id, project_revision, actor_type, actor_id, command_type, payload)
       values ($1, $2, 2, 'AGENT', 'test-agent', 'progress.record', '{}')
       returning sequence`,
      [demoProjectRecord.project.tenantId, demoProjectRecord.project.id],
    );
    expect(nextAudit.rows[0]?.sequence).toBe("2");

    await expect(
      repository.load("00000000-0000-4000-8000-ffffffffffff", demoProjectRecord.project.id),
    ).resolves.toBeNull();
  });

  it("replaces and reloads tenant-scoped EVM snapshots with ranked WBS variances", async () => {
    const snapshots = [
      {
        period: {
          periodStart: "2026-08-03",
          periodEnd: "2026-08-09",
          statusDate: "2026-08-07",
        },
        metrics: {
          bac: 4_700_000,
          pv: 3_666_666.67,
          ev: 2_147_500,
          ac: 2_820_000,
          sv: -1_519_166.67,
          cv: -672_500,
          spi: 0.5857,
          cpi: 0.7615,
          eac: 6_171_828.37,
          etc: 3_351_828.37,
          vac: -1_471_828.37,
          tcpi: 1.2766,
        },
        wbsVariances: [
          {
            id: demoProjectRecord.activities[3]!.id,
            wbs: "2.2",
            pv: 950_000,
            ev: 427_500,
            ac: 700_000,
            sv: -522_500,
            cv: -272_500,
          },
        ],
      },
    ];

    await performanceRepository.replace(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
      demoProjectRecord.baseline!.version.id,
      snapshots,
    );

    await expect(
      performanceRepository.load(
        demoProjectRecord.project.tenantId,
        demoProjectRecord.project.id,
      ),
    ).resolves.toEqual(snapshots);
    await expect(
      performanceRepository.load(
        "00000000-0000-4000-8000-ffffffffffff",
        demoProjectRecord.project.id,
      ),
    ).resolves.toEqual([]);
  });

  it("calculates and stores replayable weekly performance from persisted actuals", async () => {
    const snapshots = await performanceRepository.refresh(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
    );
    expect(snapshots).toHaveLength(4);
    expect(snapshots.at(-1)).toMatchObject({
      period: { statusDate: "2026-08-07" },
      metrics: { bac: 4_700_000, ev: 2_147_500, ac: 2_820_000 },
    });

    await expect(
      performanceRepository.load(
        demoProjectRecord.project.tenantId,
        demoProjectRecord.project.id,
      ),
    ).resolves.toEqual(snapshots);
  });

  it("loads Current, approved Baseline, and revision for the workspace", async () => {
    const workspace = await workspaceRepository.load(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
    );
    expect(workspace).toMatchObject({
      revision: 1n,
      current: { id: demoProjectRecord.project.id, tasks: expect.any(Array) },
      baseline: { id: demoProjectRecord.project.id, tasks: expect.any(Array) },
      baselineVersion: { version: 1, label: "Approved launch plan" },
    });
    expect(workspace?.current.tasks[2]).toMatchObject({
      progressPercent: 65,
      actualMinutes: 4_080,
      actualCost: 800_000,
    });
    expect(workspace?.baseline?.tasks[2]).toMatchObject({
      durationWorkingDays: 6,
      requiredSkillIds: [demoProjectRecord.skills[1]!.id],
      progressPercent: 0,
      actualMinutes: 0,
      actualCost: 0,
    });
    expect(workspace?.baseline?.resources[2]).toMatchObject({
      id: demoProjectRecord.resources[2]!.id,
      name: "Noah Williams",
      skillIds: [demoProjectRecord.skills[1]!.id],
      costRateMinorPerHour: 7_000,
    });
    expect(workspace?.baseline?.assignments).toContainEqual({
      taskId: demoProjectRecord.activities[2]!.id,
      resourceId: demoProjectRecord.resources[2]!.id,
      unitsPercent: 100,
    });
  });

  it("keeps the approved Baseline resource plan frozen when Current changes", async () => {
    const resource = demoProjectRecord.resources[2]!;
    const task = demoProjectRecord.activities[2]!;
    await client.query(
      "update resources set name = 'Current replacement', cost_rate_minor_per_hour = 9999 where tenant_id = $1 and project_id = $2 and id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, resource.id],
    );
    await client.query(
      "update skills set name = 'Current renamed skill' where tenant_id = $1 and project_id = $2 and id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, demoProjectRecord.skills[1]!.id],
    );
    await client.query(
      "delete from resource_skills where tenant_id = $1 and project_id = $2 and resource_id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, resource.id],
    );
    await client.query(
      "delete from activity_skill_requirements where tenant_id = $1 and project_id = $2 and activity_id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, task.id],
    );
    await client.query(
      "update activities set owner = 'Current owner' where tenant_id = $1 and project_id = $2 and id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, task.id],
    );
    await client.query(
      "delete from assignments where tenant_id = $1 and project_id = $2 and activity_id = $3",
      [demoProjectRecord.tenant.id, demoProjectRecord.project.id, task.id],
    );

    const workspace = await workspaceRepository.load(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
    );

    expect(workspace?.current.resources[2]).toMatchObject({
      name: "Current replacement",
      skillIds: [],
      costRateMinorPerHour: 9_999,
    });
    expect(workspace?.current.skills[1]).toMatchObject({ name: "Current renamed skill" });
    expect(workspace?.current.tasks[2]?.requiredSkillIds).toEqual([]);
    expect(workspace?.current.tasks[2]?.owner).toBe("Current owner");
    expect(workspace?.current.assignments).not.toContainEqual(expect.objectContaining({ taskId: task.id }));
    expect(workspace?.baseline?.resources[2]).toMatchObject({
      name: "Noah Williams",
      skillIds: [demoProjectRecord.skills[1]!.id],
      costRateMinorPerHour: 7_000,
    });
    expect(workspace?.baseline?.skills[1]).toMatchObject({ name: "API engineering" });
    expect(workspace?.baseline?.tasks[2]?.requiredSkillIds).toEqual([demoProjectRecord.skills[1]!.id]);
    expect(workspace?.baseline?.tasks[2]?.owner).toBe("Noah Williams");
    expect(workspace?.baseline?.assignments).toContainEqual({
      taskId: task.id,
      resourceId: resource.id,
      unitsPercent: 100,
    });
  });

  it("enforces project and baseline boundaries on stored performance", async () => {
    const draftBaselineId = "00000000-0000-4000-8000-000000000099";
    await client.query("begin");
    await client.query("set constraints all deferred");
    await client.query(
      `insert into baseline_versions
         (id, tenant_id, project_id, version, label, default_calendar_id)
       values ($1, $2, $3, 2, 'Draft plan', 'standard')`,
      [
        draftBaselineId,
        demoProjectRecord.project.tenantId,
        demoProjectRecord.project.id,
      ],
    );
    await client.query(
      `insert into baseline_calendars
         (tenant_id, project_id, baseline_version_id, source_calendar_id, name, working_weekdays, non_working_dates)
       select tenant_id, project_id, $1, source_calendar_id, name, working_weekdays, non_working_dates
       from baseline_calendars where baseline_version_id = $2`,
      [draftBaselineId, demoProjectRecord.baseline!.version.id],
    );
    await client.query("commit");
    await expect(
      performanceRepository.replace(
        demoProjectRecord.project.tenantId,
        demoProjectRecord.project.id,
        draftBaselineId,
        calculateProjectPerformance(demoProjectRecord),
      ),
    ).rejects.toThrow("EVM snapshots require an approved baseline version");

    await expect(
      client.query(
        `insert into period_buckets
           (tenant_id, project_id, status_date, period_start, period_end)
         values ('00000000-0000-4000-8000-ffffffffffff', $1, '2026-08-07', '2026-08-03', '2026-08-09')`,
        [demoProjectRecord.project.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await client.query(
      `insert into period_buckets
         (tenant_id, project_id, status_date, period_start, period_end)
       values ($1, $2, '2026-08-07', '2026-08-03', '2026-08-09')`,
      [demoProjectRecord.project.tenantId, demoProjectRecord.project.id],
    );
    await expect(
      client.query(
        `insert into evm_snapshots
           (tenant_id, project_id, status_date, baseline_version_id, bac, pv, ev, ac, sv, cv)
         values ($1, $2, '2026-08-07', $3, -1, 0, 0, 0, 0, 0)`,
        [
          demoProjectRecord.project.tenantId,
          demoProjectRecord.project.id,
          demoProjectRecord.baseline!.version.id,
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
