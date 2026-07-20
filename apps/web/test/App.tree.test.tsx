// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { projectWbsGrid, type ProjectState } from "@earned-signal/application";
import { App, reparentCommand, resolveReparentTarget, type DragData } from "../src/App.js";
import { createDemoProject } from "../src/demo-project.js";
import type { ProjectApiClient } from "../src/project-api-client.js";

// Same no-layout shims as App.test.tsx so both virtualizers materialize rows.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 720 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1440 });
});

afterEach(() => cleanup());

const project: ProjectState = createDemoProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 2 });
const grid = projectWbsGrid(project);
const parentA = project.tasks.find((task) => task.parentId === null)!;
const childrenOfA = project.tasks.filter((task) => task.parentId === parentA.id);

function fakeClient(execute = vi.fn(async () => ({ revision: "8", replayed: false }))): {
  readonly client: ProjectApiClient;
  readonly execute: typeof execute;
} {
  const client: ProjectApiClient = {
    load: async () => ({ revision: "7", current: project }),
    grid: async () => grid,
    execute,
  };
  return { client, execute };
}

async function ready(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-col="name"]')).not.toBeNull();
    expect(screen.getByTestId("save-state").textContent).toBe("saved");
  });
}

describe("resolveReparentTarget / reparentCommand (drop decision)", () => {
  const active: DragData = { id: "child", parentId: "p1", name: "Child" };

  it("nests the dragged row under the drop target for a legal move", () => {
    const over: DragData = { id: "p2", parentId: null, name: "Parent 2" };
    expect(resolveReparentTarget(active, over, () => false)).toBe("p2");
    expect(reparentCommand(active, over, () => false)).toEqual({
      type: "task.update",
      taskId: "child",
      changes: { parentId: "p2" },
    });
  });

  it("rejects dropping a row onto itself", () => {
    const over: DragData = { id: "child", parentId: "p1", name: "Child" };
    expect(resolveReparentTarget(active, over, () => false)).toBeNull();
    expect(reparentCommand(active, over, () => false)).toBeNull();
  });

  it("treats a drop onto the current parent as a no-op", () => {
    const over: DragData = { id: "p1", parentId: null, name: "Parent 1" };
    expect(reparentCommand(active, over, () => false)).toBeNull();
  });

  it("rejects dropping a row into its own subtree (would create a cycle)", () => {
    const over: DragData = { id: "grandchild", parentId: "child", name: "Grandchild" };
    // grandchild is within the active row's subtree.
    expect(reparentCommand(active, over, (id) => id === "grandchild")).toBeNull();
  });
});

describe("App hybrid flat/tree toggle", () => {
  it("switches between flat and tree layouts, showing tree affordances only in tree mode", async () => {
    const { client } = fakeClient();
    render(<App client={client} />);
    await ready();

    // Flat mode (default): no chevrons or drag handles.
    expect(document.querySelector('[data-testid="tree-toggle"]')).toBeNull();
    expect(document.querySelector('[data-testid="drag-grip"]')).toBeNull();

    fireEvent.click(screen.getByTestId("view-mode-tree"));

    await waitFor(() => {
      expect(document.querySelector('[data-testid="tree-toggle"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="drag-grip"]')).not.toBeNull();
    });
    // Roots are depth 0, subtasks depth 1 (visible because parents start expanded).
    expect(document.querySelector(`.grid-row[data-row-id="${parentA.id}"]`)?.getAttribute("data-depth")).toBe("0");
    expect(
      document.querySelector(`.grid-row[data-row-id="${childrenOfA[0]!.id}"]`)?.getAttribute("data-depth"),
    ).toBe("1");

    fireEvent.click(screen.getByTestId("view-mode-flat"));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="tree-toggle"]')).toBeNull();
      expect(document.querySelector('[data-testid="drag-grip"]')).toBeNull();
    });
  });

  it("collapses and re-expands a parent through its chevron", async () => {
    const { client } = fakeClient();
    render(<App client={client} />);
    await ready();
    fireEvent.click(screen.getByTestId("view-mode-tree"));

    await waitFor(() => {
      expect(document.querySelector('[data-testid="tree-toggle"]')).not.toBeNull();
    });
    // 2 parents + 3 + 3 children, all visible while expanded.
    const expandedCount = document.querySelectorAll(".grid-row").length;
    expect(expandedCount).toBe(project.tasks.length);
    // A child of parent A is present.
    expect(document.querySelector(`.grid-row[data-row-id="${childrenOfA[0]!.id}"]`)).not.toBeNull();

    const toggle = document.querySelector(
      `[data-testid="tree-toggle"][data-task-id="${parentA.id}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(toggle);

    await waitFor(() => {
      // Parent A's three children drop out of the visible set.
      expect(document.querySelector(`.grid-row[data-row-id="${childrenOfA[0]!.id}"]`)).toBeNull();
      expect(document.querySelectorAll(".grid-row").length).toBe(expandedCount - childrenOfA.length);
    });

    fireEvent.click(
      document.querySelector(`[data-testid="tree-toggle"][data-task-id="${parentA.id}"]`) as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(document.querySelector(`.grid-row[data-row-id="${childrenOfA[0]!.id}"]`)).not.toBeNull();
      expect(document.querySelectorAll(".grid-row").length).toBe(expandedCount);
    });
  });

  it("keeps the daily columns and inline editing working in tree mode (no regression)", async () => {
    const { client, execute } = fakeClient();
    render(<App client={client} />);
    await ready();
    fireEvent.click(screen.getByTestId("view-mode-tree"));
    await waitFor(() => expect(document.querySelector('[data-testid="drag-grip"]')).not.toBeNull());

    // An inline effort (L) edit still dispatches task.update in tree mode.
    const cell = document.querySelector('[data-col="plannedEffortMinutes"]') as HTMLElement;
    fireEvent.doubleClick(cell);
    const editor = cell.querySelector("input.cell-editor") as HTMLInputElement;
    expect(editor).not.toBeNull();
    fireEvent.change(editor, { target: { value: "7" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    // Row 0 in tree mode is the first root; the inline effort edit still routes
    // through executeCommand as task.update (7h = 420 min).
    expect(execute).toHaveBeenCalledWith(
      { type: "task.update", taskId: parentA.id, changes: { plannedEffortMinutes: 420 } },
      "7",
    );
  });
});
