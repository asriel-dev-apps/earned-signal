// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProjectCommand, type ProjectCommand, type ProjectState } from "@vecta/application";
import { TemplateScreen } from "../src/TemplateScreen.js";
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
      throw new Error("TemplateScreen must not call grid()");
    },
    execute,
  };
  return { client, execute };
}

describe("TemplateScreen (Design 0003 §E-1)", () => {
  it("renders the template list and the selected template's step editor", async () => {
    const { client } = statefulFakeClient(seed);
    render(<TemplateScreen client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    expect(screen.getByTestId("template-screen")).toBeTruthy();
    // Both seeded defaults appear in the list.
    expect(screen.getByDisplayValue("Standard build")).toBeTruthy();
    expect(screen.getByDisplayValue("Design and review")).toBeTruthy();
    // The first template is selected by default; its steps render (Rework is
    // unique to the Standard build template).
    expect(screen.getByDisplayValue("Rework")).toBeTruthy();
  });

  it("dispatches template.add when a new template is added", async () => {
    const { client, execute } = statefulFakeClient(seed);
    render(<TemplateScreen client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    const input = screen.getByLabelText("テンプレートを追加") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Spike template" } });
    fireEvent.click(screen.getByTestId("template-add"));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const command = execute.mock.calls[0]![0];
    if (command.type !== "template.add") throw new Error(`expected template.add, got ${command.type}`);
    expect(command.template.name).toBe("Spike template");
    expect(command.template.sortOrder).toBe(seed.templates.length);
    expect(command.template.subtasks).toEqual([]);
  });

  it("dispatches template.update with the new step array when a step is added", async () => {
    const { client, execute } = statefulFakeClient(seed);
    render(<TemplateScreen client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    const standardBuild = seed.templates.find((template) => template.name === "Standard build")!;
    fireEvent.click(screen.getByTestId("template-step-add"));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const command = execute.mock.calls[0]![0];
    if (command.type !== "template.update") {
      throw new Error(`expected template.update, got ${command.type}`);
    }
    expect(command.templateId).toBe(standardBuild.id);
    expect(command.changes.subtasks).toHaveLength(standardBuild.subtasks.length + 1);
    expect(command.changes.subtasks!.at(-1)).toEqual({ name: "Step", weightBp: 0 });
  });

  it("dispatches template.delete when a template is deleted", async () => {
    const { client, execute } = statefulFakeClient(seed);
    render(<TemplateScreen client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    const standardBuild = seed.templates.find((template) => template.name === "Standard build")!;
    fireEvent.click(screen.getByLabelText("Standard build を削除"));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const command = execute.mock.calls[0]![0];
    if (command.type !== "template.delete") {
      throw new Error(`expected template.delete, got ${command.type}`);
    }
    expect(command.templateId).toBe(standardBuild.id);
  });
});
