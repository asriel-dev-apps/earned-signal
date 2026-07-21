// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectCommand, ProjectState } from "@vecta/application";
import { TemplateSection } from "../src/TemplateSection.js";
import { createDemoProject } from "../src/demo-project.js";

afterEach(() => cleanup());

const seed: ProjectState = createDemoProject({ parentCount: 2, subtasksPerParent: 2, memberCount: 2 });

// The template master is now a section inside the マスタ screen. The host owns the
// project state + command dispatch, so these unit tests drive the section directly
// with a spy `executeCommand` and assert the same `template.*` commands the
// standalone screen produced. MasterScreen.test covers the wired round trip.
describe("TemplateSection (Design 0003 §E-1, embedded in マスタ)", () => {
  it("renders the template list and the selected template's step editor", () => {
    render(<TemplateSection templates={seed.templates} editable executeCommand={vi.fn()} />);

    expect(screen.getByTestId("template-screen")).toBeTruthy();
    // Both seeded defaults appear in the list.
    expect(screen.getByDisplayValue("Standard build")).toBeTruthy();
    expect(screen.getByDisplayValue("Design and review")).toBeTruthy();
    // The first template is selected by default; its steps render (Rework is
    // unique to the Standard build template).
    expect(screen.getByDisplayValue("Rework")).toBeTruthy();
  });

  it("dispatches template.add when a new template is added", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);

    const input = screen.getByLabelText("テンプレートを追加") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Spike template" } });
    fireEvent.click(screen.getByTestId("template-add"));

    expect(executeCommand).toHaveBeenCalledOnce();
    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.add") throw new Error(`expected template.add, got ${command.type}`);
    expect(command.template.name).toBe("Spike template");
    expect(command.template.sortOrder).toBe(seed.templates.length);
    expect(command.template.subtasks).toEqual([]);
  });

  it("dispatches template.update with the new step array when a step is added", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);

    const standardBuild = seed.templates.find((template) => template.name === "Standard build")!;
    fireEvent.click(screen.getByTestId("template-step-add"));

    expect(executeCommand).toHaveBeenCalledOnce();
    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.update") {
      throw new Error(`expected template.update, got ${command.type}`);
    }
    expect(command.templateId).toBe(standardBuild.id);
    expect(command.changes.subtasks).toHaveLength(standardBuild.subtasks.length + 1);
    expect(command.changes.subtasks!.at(-1)).toEqual({ name: "Step", weightBp: 0 });
  });

  it("dispatches template.delete when a template is deleted", () => {
    const executeCommand = vi.fn<(command: ProjectCommand) => void>();
    render(<TemplateSection templates={seed.templates} editable executeCommand={executeCommand} />);

    const standardBuild = seed.templates.find((template) => template.name === "Standard build")!;
    fireEvent.click(screen.getByLabelText("Standard build を削除"));

    expect(executeCommand).toHaveBeenCalledOnce();
    const command = executeCommand.mock.calls[0]![0];
    if (command.type !== "template.delete") {
      throw new Error(`expected template.delete, got ${command.type}`);
    }
    expect(command.templateId).toBe(standardBuild.id);
  });
});
