// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateScenario, type ScenarioPlanCommand, type StaffingProposalResult } from "@earned-signal/application";
import { App } from "../src/App.js";
import { baselineProject, initialProject } from "../src/demo-project.js";
import { ProjectApiError, type ProjectApiClient, type ScenarioDocument, type StaffingProposalDocument, type WorkspaceDocument } from "../src/project-api-client.js";

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

function staffingSolution(): StaffingProposalResult {
  return {
    status: "OPTIMAL",
    problem: {
      version: "staffing-problem-v1",
      sourceProjectRevision: "7",
      current: initialProject,
      tasks: [],
      candidateResources: [],
      constraints: {
        version: "staffing-constraints-v1", deadline: null, maxPlannedLaborCostMinor: null,
        maxOvertimeMinutes: 0, maxAssignmentChanges: 1, maxScheduleChanges: 1,
        maxCandidateResources: 0, requireSkillCoverage: true,
      },
      objective: { version: "staffing-objective-v1", priorities: ["MINIMIZE_FINISH", "MINIMIZE_OVERTIME", "MINIMIZE_COST", "MINIMIZE_CHANGE"] },
    },
    changes: scenarioChanges,
    plan: { ...initialProject, tasks: initialProject.tasks.map((task) => task.id === scenarioTask.id ? { ...task, durationWorkingDays: task.durationWorkingDays + 2 } : task) },
    metrics: {
      finish: "2026-09-01", plannedLaborCostMinor: 4_200_000, overtimeMinutes: 0,
      assignmentChanges: 0, scheduleChanges: 1, candidateResources: 0, skillGapTaskIds: [],
      capacity: { resources: [], overallocatedResourceIds: [], skillGapActivityIds: [] },
    },
    explanation: { summary: "Staggering work protects the deadline.", details: ["No verified overtime is required."] },
    diagnostics: [],
    solverMetadata: {
      solverVersion: "9.14.0", deterministicSeed: 20260716, workers: 1,
      timeLimitSecondsPerStage: 5, deterministicTimeLimitPerStage: 1, objectives: [],
    },
  };
}

function staffingDocument(overrides: Partial<StaffingProposalDocument> = {}): StaffingProposalDocument {
  return {
    id: "00000000-0000-4000-8000-000000000066",
    name: "Recovery staffing",
    status: "REQUESTED",
    baseProjectRevision: "7",
    linkedScenarioId: null,
    latestRun: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
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
    staffingProposals: vi.fn(async () => []),
    loadStaffingProposal: vi.fn(async () => { throw new Error("not used"); }),
    requestStaffingProposal: vi.fn(async () => { throw new Error("not used"); }),
    forecastRuns: vi.fn(async () => []),
    loadForecastRun: vi.fn(async () => { throw new Error("not used"); }),
    requestForecastRun: vi.fn(async () => { throw new Error("not used"); }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("persisted project workspace", () => {
  it("shows task identity, BAC, dependency blocking, EVM, and a dated Gantt", async () => {
    render(<App />);

    expect(await screen.findByLabelText(/Gantt timeline .* through/)).toBeTruthy();
    expect(screen.getAllByLabelText(/through .* complete/).length).toBe(initialProject.tasks.length);
    expect(screen.getByRole("columnheader", { name: "Task ID" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "WBS" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "BAC" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Blocked by" })).toBeTruthy();
    expect(screen.getByLabelText("Critical path blocking relationships")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /A1.*A2.*FS/ }));
    expect(screen.getByRole("heading", { name: "Approve experience flows" })).toBeTruthy();
    const details = screen.getByRole("button", { name: "Show details" });
    fireEvent.click(details);
    expect(screen.getByRole("button", { name: "Hide details" })).toBeTruthy();
  });

  it("confirms a preview task addition where a mobile user can see it", async () => {
    render(<App />);
    expect(await screen.findByText(/9 work packages/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add work package/ }));

    expect(screen.getByText(/10 work packages/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("A10 added");
    await waitFor(() => expect(screen.getByRole("row", { name: /A10/ }).getAttribute("aria-selected")).toBe("true"));
  });

  it("does not pretend that Staffing optimization is available in demo mode", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Staffing Proposals" }));

    expect(await screen.findByText("Staffing Proposals require a connected project")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request proposal" })).toBeNull();
  });

  it("requires explicit human confirmation for every remaining-effort suggestion", async () => {
    const requestStaffingProposal = vi.fn<ProjectApiClient["requestStaffingProposal"]>(async () => ({
      proposal: staffingDocument({ status: "REQUESTED" }), replayed: false,
    }));
    const api = client({ requestStaffingProposal });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Staffing Proposals" }));

    const submit = await screen.findByRole("button", { name: "Request proposal" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const confirmations = screen.getAllByRole("checkbox", { name: /Confirm .* remaining effort/ });
    expect(confirmations.length).toBe(initialProject.tasks.filter((task) => task.progressPercent < 100).length);
    confirmations.forEach((checkbox) => fireEvent.click(checkbox));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(requestStaffingProposal).toHaveBeenCalledOnce());
    expect(requestStaffingProposal.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: "7",
      remainingEffort: expect.arrayContaining([expect.objectContaining({
        provenance: "HUMAN_CONFIRMED",
        maxParallelResources: 2,
      })]),
    });
  });

  it("separates verified solver facts from AI prose and opens the exact linked Scenario", async () => {
    const linked = scenarioDocument({ id: "00000000-0000-4000-8000-000000000077", name: "Linked staffing Scenario" });
    const ready = staffingDocument({
      status: "READY",
      linkedScenarioId: linked.id,
      latestRun: {
        id: "00000000-0000-4000-8000-000000000088",
        status: "READY",
        algorithmVersion: "cp-sat-v1",
        output: staffingSolution(),
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    });
    const api = client({ staffingProposals: vi.fn(async () => [ready]), scenarios: vi.fn(async () => [scenarioDocument(), linked]) });
    render(<App client={api} />);
    expect(await screen.findByText("Saved · revision 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Staffing Proposals" }));

    expect(await screen.findByText("Verified solver facts")).toBeTruthy();
    expect(screen.getByText(/AI explanation · narrative only/i)).toBeTruthy();
    expect(screen.getByText("Exact Scenario command diff")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review linked Scenario" }));

    expect(await screen.findByText("Linked staffing Scenario")).toBeTruthy();
  });
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
