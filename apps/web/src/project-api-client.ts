import type {
  ProjectCommand,
  ProjectState,
  WbsGridProjection,
} from "@vecta/application";
import { fromCommand } from "./project-command-contract.js";

export interface WorkspaceDocument {
  readonly revision: string;
  readonly current: ProjectState;
}

export class ProjectApiError extends Error {
  constructor(readonly code: string, message: string, readonly actualRevision?: string) {
    super(message);
    this.name = "ProjectApiError";
  }
}

export interface ProjectApiClient {
  load(): Promise<WorkspaceDocument>;
  grid(): Promise<WbsGridProjection>;
  execute(
    command: ProjectCommand,
    expectedRevision: string,
  ): Promise<{ readonly revision: string; readonly replayed: boolean }>;
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
    throw new ProjectApiError(
      error.error?.code ?? "REQUEST_FAILED",
      error.error?.message ?? `Request failed with ${response.status}`,
      error.error?.actualRevision,
    );
  }
  return body;
}

export function createProjectApiClient(
  config: ClientConfig,
  request: typeof fetch = fetch,
): ProjectApiClient {
  const projectUrl = `/api/tenants/${encodeURIComponent(config.tenantId)}/projects/${encodeURIComponent(config.projectId)}`;
  const headers = async () => ({ authorization: `Bearer ${await config.accessToken()}` });
  return {
    async load() {
      return (await responseJson(await request(projectUrl, { headers: await headers() }))) as WorkspaceDocument;
    },
    async grid() {
      return (await responseJson(
        await request(`${projectUrl}/wbs-grid`, { headers: await headers() }),
      )) as WbsGridProjection;
    },
    async execute(command, expectedRevision) {
      return (await responseJson(await request(`${projectUrl}/commands`, {
        method: "POST",
        headers: { ...await headers(), "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision, command: fromCommand(command) }),
      }))) as { revision: string; replayed: boolean };
    },
  };
}
