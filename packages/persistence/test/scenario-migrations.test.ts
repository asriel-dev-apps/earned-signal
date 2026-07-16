import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePersistenceDatabase } from "../src/index.js";

describe("scenario migration constraints", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await stopContainer?.();
  });

  it("enforces tenant boundaries, revision transitions, and immutable run/audit history", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000061";
    const projectId = "10000000-0000-4000-8000-000000000061";
    const scenarioId = "20000000-0000-4000-8000-000000000061";
    const runId = "30000000-0000-4000-8000-000000000061";
    await client.query("insert into tenants (id, name) values ($1, 'Scenario tenant')", [tenantId]);
    await client.query("begin");
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date, revision)
       values ($1, $2, 'Scenario project', '2026-01-01', '2026-01-01', 4)`,
      [projectId, tenantId],
    );
    await client.query(
      `insert into project_calendars
         (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
       values ($1, $2, 'standard', 'Standard', array[1,2,3,4,5], array[]::date[])`,
      [tenantId, projectId],
    );
    await client.query("commit");
    await client.query(
      `insert into scenarios
         (id, tenant_id, project_id, name, base_project_revision, changes, created_by, updated_by)
       values ($1, $2, $3, 'Recovery', 4, '[]', 'planner', 'planner')`,
      [scenarioId, tenantId, projectId],
    );

    await expect(client.query(
      `insert into scenarios
         (tenant_id, project_id, name, base_project_revision, changes, created_by, updated_by)
       values ('00000000-0000-4000-8000-ffffffffffff', $1, 'Cross tenant', 4, '[]', 'planner', 'planner')`,
      [projectId],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(client.query(
      "update scenarios set changes = '[{\"type\":\"task.update\"}]' where id = $1",
      [scenarioId],
    )).rejects.toMatchObject({ code: "40001" });
    await expect(client.query(
      `insert into scenario_runs
         (id, tenant_id, project_id, scenario_id, source_project_revision,
          source_scenario_revision, algorithm_version, input_hash, input_snapshot, output,
          actor_type, actor_id)
       values ($1, $2, $3, $4, 4, 1, 'schedule-v1', 'not-a-hash', '{}', '{}', 'HUMAN', 'planner')`,
      [runId, tenantId, projectId, scenarioId],
    )).rejects.toMatchObject({ code: "23514" });
    await client.query(
      `insert into scenario_runs
         (id, tenant_id, project_id, scenario_id, source_project_revision,
          source_scenario_revision, algorithm_version, input_hash, input_snapshot, output,
          actor_type, actor_id)
       values ($1, $2, $3, $4, 4, 1, 'schedule-v1', repeat('a', 64), '{}', '{}', 'HUMAN', 'planner')`,
      [runId, tenantId, projectId, scenarioId],
    );
    await client.query(
      `insert into scenario_audit_events
         (tenant_id, project_id, scenario_id, scenario_revision, actor_type, actor_id, event_type, payload)
       values ($1, $2, $3, 1, 'HUMAN', 'planner', 'scenario.run_saved', '{}')`,
      [tenantId, projectId, scenarioId],
    );
    await expect(client.query("update scenario_runs set output = '{\"changed\":true}' where id = $1", [runId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(client.query("delete from scenario_audit_events where scenario_id = $1", [scenarioId]))
      .rejects.toMatchObject({ code: "55000" });

    await client.query(
      `update scenarios set status = 'PUBLISHED', revision = 2, latest_run_id = $2,
         published_by = 'planner', published_at = now(), updated_by = 'planner', updated_at = now()
       where id = $1`,
      [scenarioId, runId],
    );
    await expect(client.query("update scenarios set name = 'Changed' where id = $1", [scenarioId]))
      .rejects.toMatchObject({ code: "55000" });
  });
});
