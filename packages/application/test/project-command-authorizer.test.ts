import { describe, expect, it } from "vitest";
import {
  AgentPlanApprovalRequiredError,
  createProjectCommandAuthorizer,
  createProjectQueryAuthorizer,
  ProjectAccessDeniedError,
  type ProjectAccessGrantResolver,
} from "../src/index.js";

describe("ProjectCommandAuthorizer", () => {
  it("authorizes a human editor as the stable internal audit actor", async () => {
    const resolver: ProjectAccessGrantResolver = {
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000001",
        principalType: "HUMAN",
        projectRole: "EDITOR",
        allowedScopes: [],
      }),
    };
    const authorizer = createProjectCommandAuthorizer(resolver);

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "human-editor",
          scopes: [],
        },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: { type: "task.delete", taskId: "task-1" },
      }),
    ).resolves.toEqual({
      type: "HUMAN",
      id: "90000000-0000-4000-8000-000000000001",
    });
  });

  it("authorizes an agent progress update only when both grant and token carry the scope", async () => {
    const resolver: ProjectAccessGrantResolver = {
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: ["project:progress:write"],
      }),
    };
    const authorizer = createProjectCommandAuthorizer(resolver);

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "progress-agent",
          scopes: ["project:progress:write"],
        },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: {
          type: "task.update",
          taskId: "task-1",
          changes: { progressPercent: 75 },
        },
      }),
    ).resolves.toEqual({
      type: "AGENT",
      id: "90000000-0000-4000-8000-000000000002",
    });
  });

  it("requires every applicable scope for an agent progress and actuals update", async () => {
    const resolver: ProjectAccessGrantResolver = {
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: ["project:progress:write", "project:actuals:write"],
      }),
    };
    const authorizer = createProjectCommandAuthorizer(resolver);

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "progress-agent",
          scopes: ["project:progress:write", "project:actuals:write"],
        },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: {
          type: "task.update",
          taskId: "task-1",
          changes: { progressPercent: 75, actualMinutes: 480, actualCost: 120_000 },
        },
      }),
    ).resolves.toMatchObject({ type: "AGENT" });
  });

  it("requires human approval instead of directly applying an agent plan change", async () => {
    const resolver: ProjectAccessGrantResolver = {
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: ["project:plan:write"],
      }),
    };
    const authorizer = createProjectCommandAuthorizer(resolver);

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "planning-agent",
          scopes: ["project:plan:write"],
        },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: {
          type: "task.update",
          taskId: "task-1",
          changes: { durationWorkingDays: 10 },
        },
      }),
    ).rejects.toBeInstanceOf(AgentPlanApprovalRequiredError);
  });

  it("requires human approval for an agent assignment change", async () => {
    const authorizer = createProjectCommandAuthorizer({
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: ["project:plan:write"],
      }),
    });

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "planning-agent",
          scopes: ["project:plan:write"],
        },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: {
          type: "assignment.replace",
          taskId: "task-1",
          assignments: [{ resourceId: "resource-1", unitsPercent: 100 }],
        },
      }),
    ).rejects.toBeInstanceOf(AgentPlanApprovalRequiredError);
  });

  it("denies an agent when the token omits a scope allowed by its stored grant", async () => {
    const resolver: ProjectAccessGrantResolver = {
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000002",
        principalType: "AGENT",
        projectRole: "EDITOR",
        allowedScopes: ["project:progress:write"],
      }),
    };
    const authorizer = createProjectCommandAuthorizer(resolver);

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "progress-agent",
          scopes: [],
        },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        command: {
          type: "task.update",
          taskId: "task-1",
          changes: { progressPercent: 75 },
        },
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });

  it("denies a human viewer and an identity without a project grant", async () => {
    const viewer = createProjectCommandAuthorizer({
      resolve: async () => ({
        principalId: "90000000-0000-4000-8000-000000000003",
        principalType: "HUMAN",
        projectRole: "VIEWER",
        allowedScopes: [],
      }),
    });
    const unprovisioned = createProjectCommandAuthorizer({ resolve: async () => null });
    const request = {
      identity: {
        issuer: "https://identity.example.test/",
        subject: "viewer",
        scopes: [],
      },
      tenantId: "00000000-0000-4000-8000-000000000001",
      projectId: "10000000-0000-4000-8000-000000000001",
      command: { type: "task.delete" as const, taskId: "task-1" },
    };

    await expect(viewer.authorize(request)).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    await expect(unprovisioned.authorize(request)).rejects.toBeInstanceOf(
      ProjectAccessDeniedError,
    );
  });
});

describe("ProjectQueryAuthorizer", () => {
  it("allows every provisioned project role to read performance", async () => {
    const grant = {
      principalId: "90000000-0000-4000-8000-000000000003",
      principalType: "HUMAN" as const,
      projectRole: "VIEWER" as const,
      allowedScopes: [],
    };
    const authorizer = createProjectQueryAuthorizer({ resolve: async () => grant });

    await expect(
      authorizer.authorize({
        identity: { issuer: "https://identity.example.test/", subject: "viewer", scopes: [] },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual(grant);
  });

  it("denies an identity without a project grant", async () => {
    const authorizer = createProjectQueryAuthorizer({ resolve: async () => null });
    await expect(
      authorizer.authorize({
        identity: { issuer: "https://identity.example.test/", subject: "missing", scopes: [] },
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });
});
