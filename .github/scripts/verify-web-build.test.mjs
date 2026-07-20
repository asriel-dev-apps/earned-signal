import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = path.resolve(import.meta.dirname, "verify-web-build.mjs");

async function fixture(config) {
  const root = await mkdtemp(path.join(tmpdir(), "vecta-web-build-"));
  const deploy = path.join(root, "apps/web/.wrangler/deploy");
  const output = path.join(root, "apps/web/dist/worker");
  await mkdir(deploy, { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(deploy, "config.json"), JSON.stringify({ configPath: "../../dist/worker/wrangler.json" }));
  await writeFile(path.join(output, "wrangler.json"), JSON.stringify(config));
  return root;
}

test("accepts a flattened environment-specific build with Worker-first assets", async () => {
  const root = await fixture({
    name: "vecta-staging",
    assets: { binding: "ASSETS", run_worker_first: true, directory: "../client" },
    vars: { OIDC_ISSUER: "https://identity.example.test/" },
  });
  try {
    const result = await execute(process.execPath, [script], {
      cwd: root, env: { ...process.env, DEPLOY_ENV: "staging" },
    });
    assert.match(result.stdout, /web_build_verified/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects the wrong Worker environment and an asset-first build", async () => {
  const root = await fixture({
    name: "vecta-production",
    assets: { binding: "ASSETS", directory: "../client" },
    vars: { OIDC_ISSUER: "https://identity.example.test/" },
  });
  try {
    await assert.rejects(execute(process.execPath, [script], {
      cwd: root, env: { ...process.env, DEPLOY_ENV: "staging" },
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
