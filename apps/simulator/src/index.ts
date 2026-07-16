import { Container } from "@cloudflare/containers";
export { processForecastBatch } from "./queue-consumer.js";
import { processForecastBatch } from "./queue-consumer.js";

export class ForecastSimulatorContainer extends Container {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "30s";
  override enableInternet = false;
  override pingEndpoint = "/health";
}

export default {
  async queue(batch, environment) {
    await processForecastBatch(batch, environment);
  },

  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
