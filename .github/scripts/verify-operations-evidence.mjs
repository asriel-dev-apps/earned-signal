const environment = process.env.DEPLOY_ENV;
if (environment !== "staging" && environment !== "production") {
  throw new Error("DEPLOY_ENV must be staging or production");
}

function evidenceUrl(name) {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname.endsWith(".invalid")) {
    throw new Error(`${name} must be a non-placeholder HTTPS URL without credentials`);
  }
}

function recentVerification(name) {
  const value = process.env[name];
  const verifiedAt = value === undefined ? Number.NaN : Date.parse(value);
  const age = Date.now() - verifiedAt;
  if (!Number.isFinite(verifiedAt) || age < -5 * 60_000 || age > 90 * 24 * 60 * 60_000) {
    throw new Error(`${name} must be an ISO timestamp from the last 90 days`);
  }
}

evidenceUrl("BACKUP_RESTORE_EVIDENCE_URL");
recentVerification("BACKUP_RESTORE_VERIFIED_AT");
evidenceUrl("MONITORING_EVIDENCE_URL");
recentVerification("ALERT_DRILL_VERIFIED_AT");

console.log(JSON.stringify({ event: "operations_evidence_verified", environment }));
