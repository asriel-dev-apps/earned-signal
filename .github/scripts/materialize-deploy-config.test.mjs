import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const materializer = path.join(repoRoot, ".github/scripts/materialize-deploy-config.mjs");
const readiness = path.join(repoRoot, "scripts/verify-beta-readiness.mjs");
const webConfig = "apps/web/wrangler.jsonc";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "earned-signal-deploy-config-"));
  await mkdir(path.dirname(path.join(root, webConfig)), { recursive: true });
  await copyFile(path.join(repoRoot, webConfig), path.join(root, webConfig));
  return root;
}

function environment(overrides = {}) {
  return {
    ...process.env,
    DEPLOY_ENV: "staging",
    HYPERDRIVE_ID: "abcdef0123456789abcdef0123456789",
    OTHER_HYPERDRIVE_ID: "1234567890abcdef1234567890abcdef",
    OIDC_ISSUER: "https://identity.staging.example.test/",
    OIDC_AUDIENCE: "earned-signal-api-staging",
    OIDC_JWKS_URL: "https://identity.staging.example.test/jwks",
    PRE_AUTH_RATE_LIMIT_NAMESPACE_ID: "910001",
    AUTH_RATE_LIMIT_NAMESPACE_ID: "910002",
    COMPUTE_RATE_LIMIT_NAMESPACE_ID: "910003",
    OTHER_PRE_AUTH_RATE_LIMIT_NAMESPACE_ID: "920001",
    OTHER_AUTH_RATE_LIMIT_NAMESPACE_ID: "920002",
    OTHER_COMPUTE_RATE_LIMIT_NAMESPACE_ID: "920003",
    ...overrides,
  };
}

test("materializes the web environment and passes the static deployment gate", async () => {
  const root = await fixture();
  try {
    await execute(process.execPath, [materializer], { cwd: root, env: environment() });
    const web = JSON.parse(await readFile(path.join(root, webConfig), "utf8"));
    assert.equal(web.env.staging.hyperdrive[0].id, "abcdef0123456789abcdef0123456789");
    assert.equal(web.env.staging.vars.OIDC_ISSUER, "https://identity.staging.example.test/");
    assert.deepEqual(web.env.staging.ratelimits.map((binding) => binding.namespace_id), [
      "910001",
      "910002",
      "910003",
    ]);
    await execute(process.execPath, [readiness], {
      cwd: repoRoot,
      env: {
        ...process.env,
        EARNED_SIGNAL_ENV: "staging",
        EARNED_SIGNAL_WEB_CONFIG: path.join(root, webConfig),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects reserved placeholder deployment URLs", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      execute(process.execPath, [materializer], {
        cwd: root,
        env: environment({ OIDC_ISSUER: "https://identity.example.invalid/" }),
      }),
      (error) => error instanceof Error && "stderr" in error && String(error.stderr).includes("reserved .invalid domain"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects resources shared with the other environment", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      execute(process.execPath, [materializer], {
        cwd: root,
        env: environment({ OTHER_HYPERDRIVE_ID: "abcdef0123456789abcdef0123456789" }),
      }),
      (error) => error instanceof Error && "stderr" in error && String(error.stderr).includes("must be a different"),
    );
    await assert.rejects(
      execute(process.execPath, [materializer], {
        cwd: root,
        env: environment({ OTHER_COMPUTE_RATE_LIMIT_NAMESPACE_ID: "910001" }),
      }),
      (error) => error instanceof Error && "stderr" in error && String(error.stderr).includes("six distinct"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
