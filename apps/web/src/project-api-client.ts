import type {
  ProjectCommand,
  ProjectResource,
  ProjectState,
  ScenarioPlanCommand,
  ScenarioResult,
  StaffingConstraintsV1,
  StaffingObjectiveV1,
  StaffingProposalRequest,
  StaffingProposalResult,
} from "@earned-signal/application";
import type { EvmSnapshot } from "@earned-signal/domain";
import { fromCommand } from "./project-command-contract.js";
import { ScenarioResponseSchema } from "./scenario-response-contract.js";
import { StaffingProposalResponseSchema } from "./staffing-contract.js";

export interface WorkspaceDocument {
  readonly revision: string;
  readonly current: ProjectState;
  readonly baseline: ProjectState | null;
  readonly baselineVersion: { readonly id: string; readonly version: number; readonly label: string; readonly approvedAt: string } | null;
}

export class ProjectApiError extends Error {
  constructor(readonly code: string, message: string, readonly actualRevision?: string) {
    super(message);
  }
}

export interface ProjectApiClient {
  load(): Promise<WorkspaceDocument>;
  performance(): Promise<readonly EvmSnapshot[]>;
  execute(command: ProjectCommand, expectedRevision: string): Promise<{ readonly revision: string; readonly replayed: boolean }>;
  scenarios(): Promise<readonly ScenarioDocument[]>;
  createScenario(name: string): Promise<ScenarioDocument>;
  updateScenario(scenarioId: string, expectedRevision: string, changes: readonly ScenarioPlanCommand[]): Promise<ScenarioDocument>;
  runScenario(scenarioId: string, expectedRevision: string): Promise<ScenarioDocument>;
  discardScenario(scenarioId: string, expectedRevision: string): Promise<ScenarioDocument>;
  publishScenario(scenarioId: string, expectedProjectRevision: string, expectedScenarioRevision: string): Promise<{ readonly revision: string; readonly replayed: boolean }>;
  staffingProposals(): Promise<readonly StaffingProposalDocument[]>;
  loadStaffingProposal(proposalId: string): Promise<StaffingProposalDocument>;
  requestStaffingProposal(input: StaffingProposalCreateInput): Promise<{ readonly proposal: StaffingProposalDocument; readonly replayed: boolean }>;
}

export interface StaffingProposalCreateInput {
  readonly name: string;
  readonly expectedRevision: string;
  readonly remainingEffort: StaffingProposalRequest["remainingEffort"];
  readonly candidateResources: readonly ProjectResource[];
  readonly constraints: StaffingConstraintsV1;
  readonly objective: StaffingObjectiveV1;
}

export interface StaffingProposalDocument {
  readonly id: string;
  readonly name: string;
  readonly status: "REQUESTED" | "RUNNING" | "READY" | "INFEASIBLE" | "UNKNOWN" | "FAILED";
  readonly baseProjectRevision: string;
  readonly linkedScenarioId: string | null;
  readonly latestRun: null | {
    readonly id: string;
    readonly status: "READY" | "INFEASIBLE" | "UNKNOWN" | "FAILED";
    readonly algorithmVersion: string;
    readonly output: StaffingProposalResult;
    readonly createdAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ScenarioDocument {
  readonly id: string;
  readonly name: string;
  readonly status: "DRAFT" | "PUBLISHED" | "DISCARDED";
  readonly baseProjectRevision: string;
  readonly revision: string;
  readonly changes: readonly ScenarioPlanCommand[];
  readonly latestRun: null | {
    readonly id: string;
    readonly sourceProjectRevision: string;
    readonly sourceScenarioRevision: string;
    readonly algorithmVersion: string;
    readonly inputHash: string;
    readonly output: ScenarioResult;
    readonly createdAt: string;
  };
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly discardedAt: string | null;
}

interface ClientConfig {
  readonly tenantId: string;
  readonly projectId: string;
  readonly accessToken: () => string | Promise<string>;
}

async function responseJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body as { error?: { code?: string; message?: string; actualRevision?: string } };
    throw new ProjectApiError(error.error?.code ?? "REQUEST_FAILED", error.error?.message ?? `Request failed with ${response.status}`, error.error?.actualRevision);
  }
  return body;
}

export function createProjectApiClient(config: ClientConfig, request: typeof fetch = fetch): ProjectApiClient {
  const projectUrl = `/api/tenants/${encodeURIComponent(config.tenantId)}/projects/${encodeURIComponent(config.projectId)}`;
  const scenarioUrl = `${projectUrl}/scenarios`;
  const staffingUrl = `${projectUrl}/staffing-proposals`;
  const headers = async () => ({ authorization: `Bearer ${await config.accessToken()}` });
  const pendingPublishKeys = new Map<string, string>();
  const pendingStaffingKeys = new Map<string, string>();
  const mutateScenario = async (path: string, body: unknown, method = "POST") => ScenarioResponseSchema.parse(
    await responseJson(await request(`${scenarioUrl}${path}`, {
      method,
      headers: { ...await headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  ) as ScenarioDocument;
  return {
    async load() {
      return await responseJson(await request(projectUrl, { headers: await headers() })) as WorkspaceDocument;
    },
    async performance() {
      const body = await responseJson(await request(`${projectUrl}/performance`, { headers: await headers() })) as { snapshots: readonly EvmSnapshot[] };
      return body.snapshots;
    },
    async execute(command, expectedRevision) {
      return await responseJson(await request(`${projectUrl}/commands`, {
        method: "POST",
        headers: { ...await headers(), "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision, command: fromCommand(command) }),
      })) as { revision: string; replayed: boolean };
    },
    async scenarios() {
      const body = await responseJson(await request(scenarioUrl, { headers: await headers() })) as { scenarios?: unknown };
      return ScenarioResponseSchema.array().parse(body.scenarios) as readonly ScenarioDocument[];
    },
    async createScenario(name) {
      return await mutateScenario("", { name, changes: [] });
    },
    async updateScenario(scenarioId, expectedRevision, changes) {
      return await mutateScenario(`/${encodeURIComponent(scenarioId)}`, {
        expectedRevision,
        changes: changes.map((change) => fromCommand(change)),
      }, "PATCH");
    },
    async runScenario(scenarioId, expectedRevision) {
      return await mutateScenario(`/${encodeURIComponent(scenarioId)}/runs`, { expectedRevision });
    },
    async discardScenario(scenarioId, expectedRevision) {
      return await mutateScenario(`/${encodeURIComponent(scenarioId)}/discard`, { expectedRevision });
    },
    async publishScenario(scenarioId, expectedProjectRevision, expectedScenarioRevision) {
      const attempt = `${scenarioId}:${expectedProjectRevision}:${expectedScenarioRevision}`;
      const idempotencyKey = pendingPublishKeys.get(attempt) ?? crypto.randomUUID();
      pendingPublishKeys.set(attempt, idempotencyKey);
      const result = await responseJson(await request(`${scenarioUrl}/${encodeURIComponent(scenarioId)}/publish`, {
        method: "POST",
        headers: { ...await headers(), "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ expectedProjectRevision, expectedScenarioRevision }),
      })) as { revision: string; replayed: boolean };
      pendingPublishKeys.delete(attempt);
      return result;
    },
    async staffingProposals() {
      const body = await responseJson(await request(staffingUrl, { headers: await headers() })) as { proposals?: unknown };
      return StaffingProposalResponseSchema.array().parse(body.proposals) as readonly StaffingProposalDocument[];
    },
    async loadStaffingProposal(proposalId) {
      return StaffingProposalResponseSchema.parse(await responseJson(await request(
        `${staffingUrl}/${encodeURIComponent(proposalId)}`,
        { headers: await headers() },
      ))) as StaffingProposalDocument;
    },
    async requestStaffingProposal(input) {
      const attempt = JSON.stringify(input);
      const idempotencyKey = pendingStaffingKeys.get(attempt) ?? crypto.randomUUID();
      pendingStaffingKeys.set(attempt, idempotencyKey);
      const body = await responseJson(await request(staffingUrl, {
        method: "POST",
        headers: { ...await headers(), "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(input),
      })) as { proposal?: unknown; replayed?: unknown };
      const result = {
        proposal: StaffingProposalResponseSchema.parse(body.proposal) as StaffingProposalDocument,
        replayed: body.replayed === true,
      };
      pendingStaffingKeys.delete(attempt);
      return result;
    },
  };
}
