import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePersistenceDatabase } from "../src/index.js";

describe("persistence migrations", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  it("applies the system-of-record schema to an empty PostgreSQL database", async () => {
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "activities",
      "activity_skill_requirements",
      "assignments",
      "audit_events",
      "baseline_activities",
      "baseline_calendars",
      "baseline_dependencies",
      "baseline_versions",
      "baseline_wbs_nodes",
      "command_receipts",
      "dependencies",
      "direct_actual_costs",
      "evm_snapshot_wbs_variances",
      "evm_snapshots",
      "period_buckets",
      "principals",
      "progress_measurements",
      "project_calendars",
      "project_memberships",
      "projects",
      "resource_skills",
      "resources",
      "skills",
      "tenant_memberships",
      "tenants",
      "wbs_nodes",
      "worklogs",
    ]);
  });

  it("enforces principal scope and tenant/project membership boundaries", async () => {
    const tenantA = "00000000-0000-4000-8000-000000000021";
    const tenantB = "00000000-0000-4000-8000-000000000022";
    const projectB = "10000000-0000-4000-8000-000000000022";
    const principalId = "90000000-0000-4000-8000-000000000021";
    await client.query(
      "insert into tenants (id, name) values ($1, 'Access tenant A'), ($2, 'Access tenant B')",
      [tenantA, tenantB],
    );
    await client.query("begin");
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Access project B', '2026-01-01', '2026-01-01')`,
      [projectB, tenantB],
    );
    await client.query(
      `insert into project_calendars
         (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
       values ($1, $2, 'standard', 'Standard', array[1,2,3,4,5], array[]::date[])`,
      [tenantB, projectB],
    );
    await client.query("commit");

    await expect(
      client.query(
        `insert into principals (issuer, subject, type, display_name, allowed_scopes)
         values ('https://identity.example.test/', 'human-with-agent-scope', 'HUMAN',
                 'Invalid human', array['project:progress:write'])`,
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await client.query(
      `insert into principals (id, issuer, subject, type, display_name)
       values ($1, 'https://identity.example.test/', 'bounded-human', 'HUMAN', 'Bounded human')`,
      [principalId],
    );
    await client.query(
      "insert into tenant_memberships (tenant_id, principal_id, role) values ($1, $2, 'MEMBER')",
      [tenantA, principalId],
    );
    await expect(
      client.query(
        `insert into project_memberships (tenant_id, project_id, principal_id, role)
         values ($1, $2, $3, 'EDITOR')`,
        [tenantB, projectB, principalId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects tenant/project boundary violations and invalid effort", async () => {
    const tenantA = "00000000-0000-4000-8000-000000000001";
    const tenantB = "00000000-0000-4000-8000-000000000002";
    const projectA = "10000000-0000-4000-8000-000000000001";
    const projectB = "10000000-0000-4000-8000-000000000002";
    const wbsA = "20000000-0000-4000-8000-000000000001";
    const activityA = "30000000-0000-4000-8000-000000000001";
    const resourceA = "60000000-0000-4000-8000-000000000001";
    const resourceB = "60000000-0000-4000-8000-000000000002";

    await client.query(
      "insert into tenants (id, name) values ($1, 'Tenant A'), ($2, 'Tenant B')",
      [tenantA, tenantB],
    );
    await client.query("begin");
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Project A', '2026-01-01', '2026-01-01'),
              ($3, $4, 'Project B', '2026-01-01', '2026-01-01')`,
      [projectA, tenantA, projectB, tenantB],
    );
    await client.query(
      `insert into project_calendars
         (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
       values ($1, $2, 'standard', 'Standard', array[1,2,3,4,5], array[]::date[]),
              ($3, $4, 'standard', 'Standard', array[1,2,3,4,5], array[]::date[])`,
      [tenantA, projectA, tenantB, projectB],
    );
    await client.query("commit");
    await client.query(
      "insert into wbs_nodes (id, tenant_id, project_id, code, name) values ($1, $2, $3, 'A', 'A')",
      [wbsA, tenantA, projectA],
    );
    await client.query(
      `insert into activities
         (id, tenant_id, project_id, wbs_node_id, name, duration_working_days, budget_minor, measurement_method)
       values ($1, $2, $3, $4, 'Activity A', 1, 100, 'PHYSICAL_PERCENT')`,
      [activityA, tenantA, projectA, wbsA],
    );
    await client.query(
      `insert into resources
         (id, tenant_id, project_id, name, calendar_id, daily_capacity_minutes, cost_rate_minor_per_hour)
       values ($1, $2, $3, 'Resource A', 'standard', 480, 6000),
              ($4, $5, $6, 'Resource B', 'standard', 480, 6000)`,
      [resourceA, tenantA, projectA, resourceB, tenantB, projectB],
    );

    await expect(
      client.query(
        `insert into activities
           (tenant_id, project_id, wbs_node_id, name, duration_working_days, budget_minor, measurement_method)
         values ($1, $2, $3, 'Cross tenant', 1, 100, 'PHYSICAL_PERCENT')`,
        [tenantB, projectB, wbsA],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      client.query(
        `insert into worklogs
           (tenant_id, project_id, activity_id, work_date, actual_minutes, rate_minor_per_hour, person_ref)
         values ($1, $2, $3, '2026-01-01', -1, '1000.000000', 'person-a')`,
        [tenantA, projectA, activityA],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      client.query(
        `insert into assignments
           (tenant_id, project_id, activity_id, resource_id, units_percent)
         values ($1, $2, $3, $4, 100)`,
        [tenantA, projectA, activityA, resourceB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        `insert into assignments
           (tenant_id, project_id, activity_id, resource_id, units_percent)
         values ($1, $2, $3, $4, 101)`,
        [tenantA, projectA, activityA, resourceA],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      client.query("update activities set calendar_id = 'missing' where id = $1", [activityA]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        "update activities set constraint_type = 'MUST_START_ON' where id = $1",
        [activityA],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("begin");
    await client.query("update projects set default_calendar_id = 'missing' where id = $1", [projectA]);
    await expect(client.query("commit")).rejects.toMatchObject({ code: "23503" });
    await client.query("rollback");

    await client.query(
      `insert into direct_actual_costs
         (tenant_id, project_id, activity_id, cost_date, amount_minor, description)
       values ($1, $2, $3, '2026-01-01', 9007199254740993, 'Precision check')`,
      [tenantA, projectA, activityA],
    );
    const preciseAmount = await client.query<{ amount_minor: string }>(
      "select amount_minor from direct_actual_costs where activity_id = $1",
      [activityA],
    );
    expect(preciseAmount.rows[0]?.amount_minor).toBe("9007199254740993");

    await client.query(
      `insert into progress_measurements
         (tenant_id, project_id, activity_id, measurement_date, method, progress_basis_points)
       values ($1, $2, $3, '2026-01-01', 'PHYSICAL_PERCENT', 5000)`,
      [tenantA, projectA, activityA],
    );
    await expect(
      client.query(
        `insert into progress_measurements
           (tenant_id, project_id, activity_id, measurement_date, method, progress_basis_points)
         values ($1, $2, $3, '2026-01-01', 'PHYSICAL_PERCENT', 6000)`,
        [tenantA, projectA, activityA],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps approved baseline records immutable", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000011";
    const projectId = "10000000-0000-4000-8000-000000000011";
    const versionId = "40000000-0000-4000-8000-000000000011";
    const sourceWbsNodeId = "20000000-0000-4000-8000-000000000011";
    const sourceActivityId = "30000000-0000-4000-8000-000000000011";

    await client.query("insert into tenants (id, name) values ($1, 'Baseline tenant')", [
      tenantId,
    ]);
    await client.query("begin");
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Baseline project', '2026-01-01', '2026-01-01')`,
      [projectId, tenantId],
    );
    await client.query(
      `insert into project_calendars
         (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
       values ($1, $2, 'standard', 'Standard', array[1,2,3,4,5], array[]::date[])`,
      [tenantId, projectId],
    );
    await client.query(
      `insert into baseline_versions
         (id, tenant_id, project_id, version, label, approved_at, approved_by)
       values ($1, $2, $3, 1, 'Approved plan', null, null)`,
      [versionId, tenantId, projectId],
    );
    await client.query(
      `insert into baseline_calendars
         (tenant_id, project_id, baseline_version_id, source_calendar_id, name,
          working_weekdays, non_working_dates)
       values ($1, $2, $3, 'standard', 'Standard', array[1,2,3,4,5], array[]::date[])`,
      [tenantId, projectId, versionId],
    );
    await client.query("commit");
    await client.query(
      `insert into baseline_wbs_nodes
         (tenant_id, project_id, baseline_version_id, source_wbs_node_id, code, name, sort_order)
       values ($1, $2, $3, $4, '1', 'Approved WBS', 0)`,
      [tenantId, projectId, versionId, sourceWbsNodeId],
    );
    await client.query(
      `insert into baseline_activities
         (tenant_id, project_id, baseline_version_id, source_activity_id, source_wbs_node_id,
          wbs_code, name, duration_working_days, baseline_start, baseline_finish, budget_minor,
          measurement_method)
       values ($1, $2, $3, $4, $5, '1.1', 'Approved activity', 1,
               '2026-01-01', '2026-01-01', 100, 'PHYSICAL_PERCENT')`,
      [tenantId, projectId, versionId, sourceActivityId, sourceWbsNodeId],
    );
    await client.query(
      "update baseline_versions set approved_at = now(), approved_by = 'planner@example.test' where id = $1",
      [versionId],
    );

    await expect(
      client.query("update baseline_versions set label = 'Changed' where id = $1", [versionId]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query(
        `insert into baseline_wbs_nodes
           (tenant_id, project_id, baseline_version_id, source_wbs_node_id, code, name, sort_order)
         values ($1, $2, $3, '20000000-0000-4000-8000-000000000012', '2', 'Late WBS', 1)`,
        [tenantId, projectId, versionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query("delete from baseline_activities where source_activity_id = $1", [
        sourceActivityId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query(
        "update baseline_calendars set name = 'Changed' where baseline_version_id = $1",
        [versionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await client.query(
      `insert into audit_events
         (tenant_id, project_id, project_revision, actor_type, actor_id, command_type, payload, occurred_at)
       values ($1, $2, 1, 'HUMAN', 'planner@example.test', 'baseline.approve', '{}',
               '2026-07-13 09:00:00+09')`,
      [tenantId, projectId],
    );
    await client.query("set timezone = 'America/New_York'");
    const auditInstant = await client.query<{ utc_instant: string }>(
      `select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as utc_instant
       from audit_events where project_id = $1`,
      [projectId],
    );
    expect(auditInstant.rows[0]?.utc_instant).toBe("2026-07-13T00:00:00.000Z");
    await expect(
      client.query(
        "update audit_events set payload = '{\"changed\":true}' where project_id = $1",
        [projectId],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await client.query(
      `insert into command_receipts
         (tenant_id, project_id, idempotency_key, request_hash, result_revision)
       values ($1, $2, 'immutable-key', repeat('0', 64), 1)`,
      [tenantId, projectId],
    );
    await expect(
      client.query(
        "update command_receipts set result_revision = 2 where project_id = $1",
        [projectId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
