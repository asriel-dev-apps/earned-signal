// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProjectCommand, type ProjectCommand, type ProjectState } from "@vecta/application";
import { MasterScreen } from "../src/MasterScreen.js";
import { createDemoProject } from "../src/demo-project.js";
import type { ProjectApiClient } from "../src/project-api-client.js";

afterEach(() => cleanup());

const seed: ProjectState = createDemoProject({ parentCount: 2, subtasksPerParent: 2, memberCount: 2 });

// A fake client that applies each command to its own project copy (the same
// applyProjectCommand the server runs) and serves it back from load, so the
// screen settles on the post-command state after the save → reload round trip.
function statefulFakeClient(project: ProjectState): {
  readonly client: ProjectApiClient;
  readonly execute: ReturnType<typeof vi.fn<(command: ProjectCommand, revision: string) => Promise<{ revision: string; replayed: boolean }>>>;
} {
  let current = project;
  let revisionCounter = 7;
  const execute = vi.fn(async (command: ProjectCommand) => {
    current = applyProjectCommand(current, command);
    revisionCounter += 1;
    return { revision: String(revisionCounter), replayed: false };
  });
  const client: ProjectApiClient = {
    load: async () => ({ revision: String(revisionCounter), current }),
    grid: async () => {
      throw new Error("MasterScreen must not call grid()");
    },
    execute,
  };
  return { client, execute };
}

describe("MasterScreen (Design 0003 §E-2 / §E-1)", () => {
  it("renders the 工程 / プロダクト / メンバー / サブタスクテンプレート sections from the loaded project", async () => {
    const { client } = statefulFakeClient(seed);
    render(<MasterScreen client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    expect(screen.getByTestId("master-section-工程")).toBeTruthy();
    expect(screen.getByTestId("master-section-プロダクト")).toBeTruthy();
    expect(screen.getByTestId("master-section-member")).toBeTruthy();
    // テンプレート is now a section within マスタ, not a separate screen.
    expect(screen.getByTestId("master-section-template")).toBeTruthy();
    // Two demo phases (A, B) render as process rows; a default template appears too.
    expect(screen.getByDisplayValue("Phase A")).toBeTruthy();
    expect(screen.getByDisplayValue("Product 1")).toBeTruthy();
    expect(screen.getByDisplayValue("Standard build")).toBeTruthy();
  });

  it("dispatches template.add from the embedded サブタスクテンプレート section through the shared client", async () => {
    const { client, execute } = statefulFakeClient(seed);
    render(<MasterScreen client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    const input = screen.getByLabelText("テンプレートを追加") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Spike template" } });
    fireEvent.click(screen.getByTestId("template-add"));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const command = execute.mock.calls[0]![0];
    if (command.type !== "template.add") throw new Error(`expected template.add, got ${command.type}`);
    expect(command.template.name).toBe("Spike template");
    expect(command.template.sortOrder).toBe(seed.templates.length);
    await waitFor(() => expect(screen.getByDisplayValue("Spike template")).toBeTruthy());
  });

  it("dispatches process.add when a new 工程 is added", async () => {
    const { client, execute } = statefulFakeClient(seed);
    render(<MasterScreen client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    const input = screen.getByLabelText("工程を追加…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Phase Z" } });
    fireEvent.click(screen.getByTestId("master-add-工程"));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const command = execute.mock.calls[0]![0];
    if (command.type !== "process.add") throw new Error(`expected process.add, got ${command.type}`);
    expect(command.process.name).toBe("Phase Z");
    // Appended after the existing masters' sort order.
    expect(command.process.sortOrder).toBe(seed.processes.length);
    await waitFor(() => expect(screen.getByDisplayValue("Phase Z")).toBeTruthy());
  });

  it("surfaces the rejection when deleting a 工程 still used by a task", async () => {
    const { client, execute } = statefulFakeClient(seed);
    render(<MasterScreen client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    // Phase A is referenced by demo tasks, so its delete must be rejected locally
    // (optimistic apply throws) and never reach the backend.
    const deleteButton = screen.getByLabelText("Phase A を削除");
    fireEvent.click(deleteButton);

    await waitFor(() => expect(screen.getByTestId("master-notice")).toBeTruthy());
    expect(screen.getByTestId("master-notice").textContent).toContain("used by a task");
    expect(execute).not.toHaveBeenCalled();
  });

  it("dispatches member.add when a new member is added", async () => {
    const { client, execute } = statefulFakeClient(seed);
    render(<MasterScreen client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    const input = screen.getByLabelText("メンバーを追加") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Member 99" } });
    fireEvent.click(screen.getByTestId("master-add-member"));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const command = execute.mock.calls[0]![0];
    if (command.type !== "member.add") throw new Error(`expected member.add, got ${command.type}`);
    expect(command.member.name).toBe("Member 99");
    expect(command.member.calendarId).toBe(seed.defaultCalendarId);
    expect(command.member.dailyCapacityMinutes).toBe(480);
  });
});
