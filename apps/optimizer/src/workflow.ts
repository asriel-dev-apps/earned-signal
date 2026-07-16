import {
  calculateScenario,
  createStaffingProposalService,
  type StaffingProposalRequest,
  type StaffingProposalResult,
} from "@earned-signal/application";
import {
  createPersistenceDatabase,
  ProjectPerformanceRepository,
  ProjectScenarioRepository,
  ProjectStaffingProposalRepository,
  ProjectWorkspaceRepository,
  type ScenarioJson,
  type ScenarioPlanChange,
  type StaffingProposalJson,
} from "@earned-signal/persistence";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Client } from "pg";
import { createStaffingExplainer } from "./explainer.js";
import { createContainerStaffingOptimizer } from "./solver-contract.js";
import { storeStaffingResultOrFail } from "./workflow-storage.js";

export interface StaffingWorkflowPayload {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proposalId: string;
}

const SYSTEM_ACTOR = { type: "SYSTEM", id: "staffing-optimizer-v1" } as const;
const ALGORITHM_VERSION = "staffing-cp-sat-v1";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertProposalRequest(value: unknown): asserts value is StaffingProposalRequest {
  const root = record(value);
  if (
    root === null ||
    typeof root.currentRevision !== "string" ||
    record(root.current) === null ||
    !Array.isArray(root.remainingEffort) ||
    !Array.isArray(root.candidateResources) ||
    record(root.constraints) === null ||
    record(root.objective) === null
  ) {
    throw new Error("Stored Staffing Proposal input is invalid");
  }
  // The Application service performs the complete Project, effort, candidate,
  // constraint, and objective validation before accepting a solver result.
}

function proposalRequest(value: StaffingProposalJson): StaffingProposalRequest {
  assertProposalRequest(value);
  return value;
}

function scenarioChanges(value: unknown): readonly ScenarioPlanChange[] {
  if (!Array.isArray(value) || value.some((entry) => {
    const candidate = record(entry);
    return candidate === null || typeof candidate.type !== "string";
  })) {
    throw new Error("Staffing Scenario changes are invalid");
  }
  return json<ScenarioJson>(value) as readonly ScenarioPlanChange[];
}

function json<T extends StaffingProposalJson | ScenarioJson>(value: unknown): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Workflow value is not JSON-safe");
  return JSON.parse(serialized) as T;
}

async function sha256(value: ScenarioJson): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

async function database(environment: Env) {
  const client = new Client({ connectionString: environment.HYPERDRIVE.connectionString });
  await client.connect();
  return createPersistenceDatabase(client);
}

function terminalStatus(result: StaffingProposalResult): "READY" | "INFEASIBLE" | "UNKNOWN" | "FAILED" {
  if (result.status === "OPTIMAL" || result.status === "FEASIBLE") return "READY";
  if (result.status === "INFEASIBLE") return "INFEASIBLE";
  if (result.status === "UNKNOWN") return "UNKNOWN";
  return "FAILED";
}

export class StaffingProposalWorkflow extends WorkflowEntrypoint<Env, StaffingWorkflowPayload> {
  override async run(event: Readonly<WorkflowEvent<StaffingWorkflowPayload>>, step: WorkflowStep): Promise<void> {
    const identity = event.payload;
    await step.do("mark proposal running", async () => {
      const db = await database(this.env);
      const proposals = new ProjectStaffingProposalRepository(db);
      const current = await proposals.load(identity.tenantId, identity.projectId, identity.proposalId);
      if (current === null) throw new Error("Staffing Proposal was not found");
      if (current.status === "REQUESTED") await proposals.markRunning({ ...identity, actor: SYSTEM_ACTOR });
      return { status: current.status };
    });

    let result: StaffingProposalResult;
    try {
      result = await step.do("solve and verify staffing proposal", {
        retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      }, async () => {
        const db = await database(this.env);
        const proposal = await new ProjectStaffingProposalRepository(db).load(
          identity.tenantId, identity.projectId, identity.proposalId,
        );
        if (proposal === null) throw new Error("Staffing Proposal was not found");
        const workspace = await new ProjectWorkspaceRepository(db).load(identity.tenantId, identity.projectId);
        if (workspace === null || workspace.revision !== proposal.baseProjectRevision) {
          throw new Error("Staffing Proposal became stale before optimization");
        }
        const container = this.env.STAFFING_SOLVER.getByName(identity.proposalId);
        const service = createStaffingProposalService({
          optimizer: createContainerStaffingOptimizer((request) => container.fetch(request)),
          explainer: createStaffingExplainer(this.env.AI),
        });
        return service.generate(proposalRequest(proposal.input));
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "staffing_proposal.failed",
        proposalId: identity.proposalId,
        error: error instanceof Error ? error.message : String(error),
      }));
      await step.do("record staffing failure", async () => {
        const db = await database(this.env);
        await new ProjectStaffingProposalRepository(db).complete({
          ...identity,
          status: "FAILED",
          algorithmVersion: ALGORITHM_VERSION,
          output: { code: "OPTIMIZATION_FAILED", message: "Staffing optimization failed" },
          actor: SYSTEM_ACTOR,
        });
        return { recorded: true };
      });
      return;
    }

    const status = terminalStatus(result);
    const storage = await storeStaffingResultOrFail({
      store: () => step.do("store staffing result", {
        retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
        timeout: "30 seconds",
      }, async () => {
        const db = await database(this.env);
        const proposals = new ProjectStaffingProposalRepository(db);
        if (status === "READY") {
          if (result.status !== "OPTIMAL" && result.status !== "FEASIBLE") {
            throw new Error("READY Staffing Proposal has no solved result");
          }
          const current = await proposals.load(identity.tenantId, identity.projectId, identity.proposalId);
          if (current === null) throw new Error("Staffing Proposal was not found");
          const completed = await proposals.completeReadyWithScenario({
            ...identity,
            algorithmVersion: ALGORITHM_VERSION,
            output: json<StaffingProposalJson>(result),
            scenarioName: `${current.name} — staffing proposal`,
            changes: scenarioChanges(result.changes),
            actor: SYSTEM_ACTOR,
          });
          if (completed.proposal.linkedScenarioId === null) {
            throw new Error("READY Staffing Proposal Scenario was not linked");
          }
          return { status, scenarioId: completed.proposal.linkedScenarioId };
        }
        await proposals.complete({
          ...identity,
          status,
          algorithmVersion: ALGORITHM_VERSION,
          output: json<StaffingProposalJson>(result),
          actor: SYSTEM_ACTOR,
        });
        return { status, scenarioId: null };
      }),
      recordFailure: (output) => step.do("record staffing result storage failure", {
        retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
        timeout: "30 seconds",
      }, async () => {
        const db = await database(this.env);
        const completed = await new ProjectStaffingProposalRepository(db).complete({
          ...identity,
          status: "FAILED",
          algorithmVersion: ALGORITHM_VERSION,
          output: json<StaffingProposalJson>(output),
          actor: SYSTEM_ACTOR,
        });
        return { recorded: completed.accepted };
      }),
    });
    if (storage.kind === "TERMINAL_FAILURE") {
      console.error(JSON.stringify({
        event: "staffing_proposal.result_storage_failed",
        proposalId: identity.proposalId,
        code: storage.failure.code,
      }));
      return;
    }
    const stored = storage.value;
    if (status !== "READY" || (result.status !== "OPTIMAL" && result.status !== "FEASIBLE")) return;
    if (stored.scenarioId === null) throw new Error("READY Staffing Proposal Scenario was not linked");
    const scenarioId = stored.scenarioId;

    await step.do("save approval scenario run", async () => {
      const db = await database(this.env);
      const scenarios = new ProjectScenarioRepository(db);
      const scenario = await scenarios.load(identity.tenantId, identity.projectId, scenarioId);
      if (scenario === null) throw new Error("Linked Staffing Scenario was not found");
      if (scenario.latestRun !== null) return { runId: scenario.latestRun.id };
      const workspace = await new ProjectWorkspaceRepository(db).load(identity.tenantId, identity.projectId);
      if (workspace === null || workspace.baseline === null) throw new Error("Staffing Scenario requires an approved Baseline");
      const snapshots = await new ProjectPerformanceRepository(db).calculate(identity.tenantId, identity.projectId);
      const metrics = snapshots.at(-1)?.metrics;
      const changes = result.status === "OPTIMAL" || result.status === "FEASIBLE" ? result.changes : [];
      const input = json<ScenarioJson>({
        algorithmVersion: ALGORITHM_VERSION,
        projectRevision: workspace.revision.toString(),
        scenarioRevision: scenario.revision.toString(),
        current: workspace.current,
        baseline: workspace.baseline,
        changes,
        trend: { spi: metrics?.spi ?? null, cpi: metrics?.cpi ?? null },
      });
      const output = json<ScenarioJson>(calculateScenario({
        current: workspace.current,
        baseline: workspace.baseline,
        changes,
        trend: { spi: metrics?.spi ?? null, cpi: metrics?.cpi ?? null },
      }));
      const run = await scenarios.saveRun({
        tenantId: identity.tenantId,
        projectId: identity.projectId,
        scenarioId,
        expectedScenarioRevision: scenario.revision,
        sourceProjectRevision: workspace.revision,
        algorithmVersion: ALGORITHM_VERSION,
        inputHash: await sha256(input),
        inputSnapshot: input,
        output,
        actor: SYSTEM_ACTOR,
      });
      return { runId: run.id };
    });
  }
}
