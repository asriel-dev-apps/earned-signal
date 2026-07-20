import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const environment = process.env.DEPLOY_ENV;
const hyperdriveId = process.env.HYPERDRIVE_ID;
const otherHyperdriveId = process.env.OTHER_HYPERDRIVE_ID;

if (environment !== "staging" && environment !== "production") {
  throw new Error("DEPLOY_ENV must be staging or production");
}
if (!/^[a-f\d]{32}$/iu.test(hyperdriveId ?? "")) {
  throw new Error("HYPERDRIVE_ID must be a 32-character hexadecimal ID");
}
if (!/^[a-f\d]{32}$/iu.test(otherHyperdriveId ?? "") || otherHyperdriveId === hyperdriveId) {
  throw new Error("OTHER_HYPERDRIVE_ID must be a different 32-character hexadecimal ID");
}

function requiredHttpsUrl(name) {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error(`${name} must be an HTTPS URL without credentials`);
  }
  if (url.hostname.endsWith(".invalid")) {
    throw new Error(`${name} must not use the reserved .invalid domain`);
  }
  return value;
}

const oidcAudience = process.env.OIDC_AUDIENCE;
if (oidcAudience === undefined || oidcAudience.length === 0 || oidcAudience.length > 255) {
  throw new Error("OIDC_AUDIENCE must contain 1 to 255 characters");
}

const rateLimitNamespaceIds = {
  PRE_AUTH_RATE_LIMIT: process.env.PRE_AUTH_RATE_LIMIT_NAMESPACE_ID,
  AUTH_RATE_LIMIT: process.env.AUTH_RATE_LIMIT_NAMESPACE_ID,
  COMPUTE_RATE_LIMIT: process.env.COMPUTE_RATE_LIMIT_NAMESPACE_ID,
};
const otherRateLimitNamespaceIds = [
  process.env.OTHER_PRE_AUTH_RATE_LIMIT_NAMESPACE_ID,
  process.env.OTHER_AUTH_RATE_LIMIT_NAMESPACE_ID,
  process.env.OTHER_COMPUTE_RATE_LIMIT_NAMESPACE_ID,
];
if (Object.values(rateLimitNamespaceIds).some((value) => !/^[1-9]\d*$/u.test(value ?? "")) ||
    new Set(Object.values(rateLimitNamespaceIds)).size !== 3) {
  throw new Error("Rate-limit namespace IDs must be three distinct positive integers");
}
if (otherRateLimitNamespaceIds.some((value) => !/^[1-9]\d*$/u.test(value ?? "")) ||
    new Set([...Object.values(rateLimitNamespaceIds), ...otherRateLimitNamespaceIds]).size !== 6) {
  throw new Error("Both environments must use six distinct positive rate-limit namespace IDs");
}

const webVars = {
  OIDC_ISSUER: requiredHttpsUrl("OIDC_ISSUER"),
  OIDC_AUDIENCE: oidcAudience,
  OIDC_JWKS_URL: requiredHttpsUrl("OIDC_JWKS_URL"),
};

for (const relativePath of ["apps/web/wrangler.jsonc"]) {
  const configPath = path.resolve(relativePath);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const target = config.env?.[environment];
  if (target === undefined || target.hyperdrive?.length !== 1) {
    throw new Error(`${relativePath} has no single Hyperdrive binding for ${environment}`);
  }
  target.hyperdrive[0].id = hyperdriveId;
  target.vars = webVars;
  if (!Array.isArray(target.ratelimits) || target.ratelimits.length !== 3) {
    throw new Error(`apps/web/wrangler.jsonc must have three rate-limit bindings for ${environment}`);
  }
  for (const binding of target.ratelimits) {
    const namespaceId = rateLimitNamespaceIds[binding.name];
    if (namespaceId === undefined) throw new Error(`Unexpected rate-limit binding ${binding.name}`);
    binding.namespace_id = namespaceId;
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
