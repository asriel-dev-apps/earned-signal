// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { baselineProject, initialProject } from "../src/demo-project.js";
import { ProjectApiError, type ProjectApiClient, type WorkspaceDocument } from "../src/project-api-client.js";

function workspace(revision: string): WorkspaceDocument {
  return {
    revision,
    current: initialProject,
    baseline: baselineProject,
    baselineVersion: {
      id: "00000000-0000-4000-8000-000000000010",
      version: 1,
      label: "Approved launch plan",
      approvedAt: "2026-07-15T00:00:00.000Z",
    },
  };
}

function client(overrides: Partial<ProjectApiClient> = {}): ProjectApiClient {
  return {
    load: vi.fn(async () => workspace("7")),
    performance: vi.fn(async () => []),
    execute: vi.fn(async () => ({ revision: "8", replayed: false })),
    ...overrides,
  };
}

afterEach(cleanup);

describe("persisted project workspace", () => {
  it("loads the authorized workspace and publishes an immutable baseline", async () => {
    const api = client({
      load: vi.fn()
        .mockResolvedValueOnce(workspace("7"))
        .mockResolvedValueOnce({ ...workspace("8"), baselineVersion: { ...workspace("8").baselineVersion!, version: 2, label: "Recovery plan" } }),
    });
    render(<App client={api} />);

    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish baseline" }));
    fireEvent.change(screen.getByLabelText("Version label"), { target: { value: "Recovery plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish immutable baseline" }));

    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(
      { type: "baseline.publish", label: "Recovery plan" },
      "7",
    ));
    expect(await screen.findByText("Saved · revision 8")).toBeTruthy();
    expect(await screen.findByText(/Baseline v2/)).toBeTruthy();
  });

  it("keeps a committed edit visible when only the post-save refresh fails", async () => {
    const api = client({
      load: vi.fn()
        .mockResolvedValueOnce(workspace("7"))
        .mockRejectedValueOnce(new Error("refresh unavailable")),
    });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add work package/ }));

    expect(await screen.findByText("Saved · revision 8")).toBeTruthy();
    expect(await screen.findByText(/Your edit was saved at revision 8/)).toBeTruthy();
  });

  it("reloads authoritative state after an optimistic conflict", async () => {
    const api = client({
      load: vi.fn()
        .mockResolvedValueOnce(workspace("7"))
        .mockResolvedValueOnce(workspace("9")),
      execute: vi.fn(async () => {
        throw new ProjectApiError("PROJECT_VERSION_CONFLICT", "conflict", "9");
      }),
    });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add work package/ }));

    expect(await screen.findByText(/reloaded at revision 9/)).toBeTruthy();
    expect(screen.getByText("Save needs attention")).toBeTruthy();
  });

  it("rolls back and reports both failures when conflict recovery cannot reload", async () => {
    const api = client({
      load: vi.fn()
        .mockResolvedValueOnce(workspace("7"))
        .mockRejectedValueOnce(new Error("reload unavailable")),
      execute: vi.fn(async () => {
        throw new ProjectApiError("PROJECT_VERSION_CONFLICT", "conflict", "9");
      }),
    });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add work package/ }));

    expect(await screen.findByText(/latest revision could not be loaded/)).toBeTruthy();
    expect(screen.getByText("Save needs attention")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/New work package/)).toBeNull());
  });
});
