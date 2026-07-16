import { Container } from "@cloudflare/containers";
export { StaffingProposalWorkflow } from "./workflow.js";

export class StaffingSolverContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = "10s";
  override enableInternet = false;
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
