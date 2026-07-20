import { readFile } from "node:fs/promises";
import path from "node:path";

const environment = process.env.DEPLOY_ENV;
if (environment !== "staging" && environment !== "production") {
  throw new Error("DEPLOY_ENV must be staging or production");
}

const webRoot = path.resolve("apps/web");
const redirectPath = path.join(webRoot, ".wrangler/deploy/config.json");
const redirect = JSON.parse(await readFile(redirectPath, "utf8"));
const configPath = path.resolve(path.dirname(redirectPath), redirect.configPath ?? "");
if (!configPath.startsWith(`${path.join(webRoot, "dist")}${path.sep}`)) {
  throw new Error("Vite deploy configuration must point inside apps/web/dist");
}
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.name !== `vecta-${environment}`) {
  throw new Error(`Vite built ${config.name ?? "an unnamed Worker"}, expected vecta-${environment}`);
}
if (config.assets?.binding !== "ASSETS" || config.assets?.run_worker_first !== true) {
  throw new Error("Vite output must route static assets through the Worker security boundary");
}
if (config.env !== undefined) throw new Error("Vite deploy configuration must be flattened to one environment");
if (JSON.stringify(config).includes("example.invalid")) {
  throw new Error("Vite deploy configuration still contains a placeholder URL");
}

console.log(JSON.stringify({ event: "web_build_verified", environment, worker: config.name }));
