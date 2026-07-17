import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = path.resolve(import.meta.dirname, "verify-operations-evidence.mjs");

function environment(overrides = {}) {
  return {
    ...process.env,
    DEPLOY_ENV: "staging",
    BACKUP_RESTORE_EVIDENCE_URL: "https://evidence.example.test/backups/restore-drill",
    BACKUP_RESTORE_VERIFIED_AT: new Date().toISOString(),
    MONITORING_EVIDENCE_URL: "https://evidence.example.test/monitoring/dashboard-and-alert",
    ALERT_DRILL_VERIFIED_AT: new Date().toISOString(),
    ...overrides,
  };
}

test("accepts recent backup and alert-drill evidence without printing its location", async () => {
  const result = await execute(process.execPath, [script], { env: environment() });
  assert.match(result.stdout, /operations_evidence_verified/u);
  assert.doesNotMatch(result.stdout, /evidence\.example/u);
});

test("rejects missing, placeholder, future, or stale evidence", async () => {
  for (const overrides of [
    { BACKUP_RESTORE_EVIDENCE_URL: "" },
    { MONITORING_EVIDENCE_URL: "https://monitoring.example.invalid/dashboard" },
    { ALERT_DRILL_VERIFIED_AT: new Date(Date.now() + 60 * 60_000).toISOString() },
    { BACKUP_RESTORE_VERIFIED_AT: new Date(Date.now() - 91 * 24 * 60 * 60_000).toISOString() },
  ]) {
    await assert.rejects(execute(process.execPath, [script], { env: environment(overrides) }));
  }
});
