// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateScenario, type ScenarioPlanCommand } from "@earned-signal/application";
import { App } from "../src/App.js";
import { baselineProject, initialProject } from "../src/demo-project.js";
import { ProjectApiError, type ProjectApiClient, type ScenarioDocument, type WorkspaceDocument } from "../src/project-api-client.js";

const scenarioTask = initialProject.tasks[0]!;
const scenarioChanges: readonly ScenarioPlanCommand[] = [{
  type: "task.update",
  taskId: scenarioTask.id,
  changes: { durationWorkingDays: scenarioTask.durationWorkingDays + 2 },
}];

function scenarioDocument(overrides: Partial<ScenarioDocument> = {}): ScenarioDocument {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    name: "Recovery plan",
    status: "DRAFT" as const,
    baseProjectRevision: "7",
    revision: "1",
    changes: scenarioChanges,
    latestRun: null,
    updatedAt: "2026-07-15T00:00:00.000Z",
    publishedAt: null,
    discardedAt: null,
    ...overrides,
  };
}

function completedRun(changes: readonly ScenarioPlanCommand[] = scenarioChanges) {
  return {
    id: "00000000-0000-4000-8000-000000000030",
    sourceProjectRevision: "7",
    sourceScenarioRevision: "2",
    algorithmVersion: "deterministic-trend-v1",
    inputHash: "a".repeat(64),
    output: calculateScenario({ current: initialProject, baseline: baselineProject, changes, trend: { spi: 1, cpi: 1 } }),
    createdAt: "2026-07-15T00:01:00.000Z",
  };
}

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
    scenarios: vi.fn(async () => []),
    createScenario: vi.fn(async () => { throw new Error("not used"); }),
    updateScenario: vi.fn(async () => { throw new Error("not used"); }),
    runScenario: vi.fn(async () => { throw new Error("not used"); }),
    discardScenario: vi.fn(async () => { throw new Error("not used"); }),
    publishScenario: vi.fn(async () => { throw new Error("not used"); }),
    ...overrides,
  };
}

afterEach(cleanup);

describe("persisted project workspace", () => {
  it("shows an editable isolated Scenario preview without representing it as Current", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Scenarios" }));

    expect(await screen.findByText("Preview only · Current unchanged")).toBeTruthy();
    expect(screen.getByText("Scenario draft · Current unchanged")).toBeTruthy();
    const days = screen.getByLabelText("Confirm launch requirements Scenario days") as HTMLInputElement;
    fireEvent.change(days, { target: { value: "9" } });
    expect(days.value).toBe("9");
  });

  it("creates a persisted Scenario from the Scenarios workspace", async () => {
    const created = {
      id: "00000000-0000-4000-8000-000000000020",
      name: "Recovery plan",
      status: "DRAFT" as const,
      baseProjectRevision: "7",
      revision: "1",
      changes: [],
      latestRun: null,
      updatedAt: "2026-07-15T00:00:00.000Z",
      publishedAt: null,
      discardedAt: null,
    };
    const api = client({ createScenario: vi.fn(async () => created) });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scenarios" }));
    fireEvent.click(await screen.findByRole("button", { name: "New scenario" }));

    await waitFor(() => expect(api.createScenario).toHaveBeenCalledWith("Recovery plan"));
    expect(await screen.findByText("Recovery plan")).toBeTruthy();
  });

  it("saves, runs, and publishes only the exact human-reviewed Scenario changes", async () => {
    const draft = scenarioDocument();
    const savedChanges: readonly ScenarioPlanCommand[] = [{
      type: "task.update",
      taskId: scenarioTask.id,
      changes: { durationWorkingDays: scenarioTask.durationWorkingDays + 3 },
    }];
    const saved = scenarioDocument({ revision: "2", changes: savedChanges });
    const ran = scenarioDocument({ revision: "2", changes: savedChanges, latestRun: completedRun(savedChanges) });
    const api = client({
      scenarios: vi.fn(async () => [draft]),
      updateScenario: vi.fn(async () => saved),
      runScenario: vi.fn(async () => ran),
      publishScenario: vi.fn(async () => ({ revision: "8", replayed: false })),
    });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scenarios" }));
    const days = await screen.findByLabelText(`${scenarioTask.name} Scenario days`) as HTMLInputElement;
    fireEvent.change(days, { target: { value: String(scenarioTask.durationWorkingDays + 3) } });
    fireEvent.click(screen.getByRole("button", { name: "Save & run" }));

    await waitFor(() => expect(api.updateScenario).toHaveBeenCalledWith(draft.id, "1", savedChanges));
    await waitFor(() => expect(api.runScenario).toHaveBeenCalledWith(draft.id, "2"));
    expect(await screen.findByText(/Run saved from the exact Current/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish to Current" }));
    expect(screen.getAllByText(new RegExp(`${scenarioTask.durationWorkingDays} → ${scenarioTask.durationWorkingDays + 3}`)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Approve and publish" }));

    await waitFor(() => expect(api.publishScenario).toHaveBeenCalledWith(draft.id, "7", "2"));
  });

  it("prevents running or publishing a stale Scenario and can discard a current draft", async () => {
    const staleDraft = scenarioDocument({ baseProjectRevision: "6", latestRun: completedRun() });
    const discarded = scenarioDocument({ baseProjectRevision: "6", revision: "2", status: "DISCARDED", discardedAt: "2026-07-15T00:02:00.000Z" });
    const api = client({
      scenarios: vi.fn(async () => [staleDraft]),
      discardScenario: vi.fn(async () => discarded),
    });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scenarios" }));

    expect(await screen.findByText("Stale · recreate from Current")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run forecast" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Publish to Current" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("heading", { name: "Discard this Scenario?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard Scenario" }));
    await waitFor(() => expect(api.discardScenario).toHaveBeenCalledWith(staleDraft.id, "1"));
  });

  it("keeps dirty edits visible over an older run and disables publication until rerun", async () => {
    const ranDraft = scenarioDocument({ latestRun: completedRun() });
    const api = client({ scenarios: vi.fn(async () => [ranDraft]) });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scenarios" }));
    const days = await screen.findByLabelText(`${scenarioTask.name} Scenario days`) as HTMLInputElement;
    const editedDays = scenarioTask.durationWorkingDays + 4;

    fireEvent.change(days, { target: { value: String(editedDays) } });

    expect(days.value).toBe(String(editedDays));
    expect((screen.getByRole("button", { name: "Publish to Current" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Save & run" })).toBeTruthy();
  });

  it("shows every supported plan command in the approval list and dialog", async () => {
    const addedTaskId = "00000000-0000-4000-8000-000000000040";
    const addedResourceId = "00000000-0000-4000-8000-000000000050";
    const allChanges: readonly ScenarioPlanCommand[] = [
      ...scenarioChanges,
      { type: "task.add", task: { ...scenarioTask, id: addedTaskId, wbs: "9.1", name: "Temporary task", dependencies: [], progressPercent: 0, actualCost: 0, actualMinutes: 0 } },
      { type: "task.delete", taskId: addedTaskId },
      { type: "resource.add", resource: { id: addedResourceId, name: "Temporary planner", calendarId: initialProject.defaultCalendarId, dailyCapacityMinutes: 480, costRateMinorPerHour: 8_000, skillIds: [] } },
      { type: "resource.update", resourceId: addedResourceId, changes: { name: "Recovery planner" } },
      { type: "assignment.replace", taskId: scenarioTask.id, assignments: [{ resourceId: addedResourceId, unitsPercent: 50 }] },
      { type: "assignment.replace", taskId: scenarioTask.id, assignments: [] },
      { type: "resource.delete", resourceId: addedResourceId },
    ];
    const draft = scenarioDocument({ changes: allChanges, latestRun: completedRun(allChanges) });
    const api = client({ scenarios: vi.fn(async () => [draft]) });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scenarios" }));

    for (const text of ["Add task", "Delete task", "Add resource", "Recovery planner", "Replace assignments", "Delete resource"]) {
      expect((await screen.findAllByText(new RegExp(text))).length).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getByRole("button", { name: "Publish to Current" }));
    expect(screen.getByRole("heading", { name: "Publish Scenario to Current?" })).toBeTruthy();
    expect(screen.getAllByText(/Add task/).length).toBe(2);
    expect(screen.getAllByText(/Delete resource/).length).toBe(2);
  });

  it("gates Scenario creation when the authorized list cannot be loaded", async () => {
    const api = client({ scenarios: vi.fn(async () => { throw new Error("scenario service unavailable"); }) });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scenarios" }));

    expect(await screen.findByText("Scenarios could not be loaded")).toBeTruthy();
    expect((screen.getByRole("button", { name: "New scenario" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/No Scenarios yet/)).toBeNull();
  });

  it("gates Current editing when publication commits but the authoritative reload fails", async () => {
    const ready = scenarioDocument({ latestRun: completedRun() });
    const api = client({
      load: vi.fn().mockResolvedValueOnce(workspace("7")).mockRejectedValueOnce(new Error("reload unavailable")),
      scenarios: vi.fn(async () => [ready]),
      publishScenario: vi.fn(async () => ({ revision: "8", replayed: false })),
    });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scenarios" }));
    fireEvent.click(await screen.findByRole("button", { name: "Publish to Current" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve and publish" }));

    expect(await screen.findByText("Save needs attention")).toBeTruthy();
    expect(screen.getByText(/updated Current could not be loaded/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Publish baseline" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Retry workspace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Work breakdown" }));
    expect((screen.getByRole("button", { name: /Add work package/ }) as HTMLButtonElement).disabled).toBe(true);
  });

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
