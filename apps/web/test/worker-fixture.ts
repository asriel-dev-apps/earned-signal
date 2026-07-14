import { createApiApp } from "../src/api.js";
import { openHyperdriveCommandSession } from "../src/worker.js";

export default createApiApp({
  resolveActor: async () => ({ type: "HUMAN", id: "worker-integration-test" }),
  openCommandSession: openHyperdriveCommandSession,
});
