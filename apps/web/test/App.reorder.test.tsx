// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { projectWbsGrid, type ProjectState } from "@vecta/application";
import { App, reorderSiblingCommands, type DragData } from "../src/App.js";
import { createDemoProject } from "../src/demo-project.js";
import type { ProjectApiClient } from "../src/project-api-client.js";

// Same no-layout shims as the other grid suites so both virtualizers materialize
// rows in happy-dom.
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
const rows = grid.rows;
const roots = project.tasks.filter((task) => task.parentId === null);
const parentA = roots[0]!;
const parentB = roots[1]!;
const childrenOfA = project.tasks.filter((task) => task.parentId === parentA.id);
const childrenOfB = project.tasks.filter((task) => task.parentId === parentB.id);

/** Build the drag payload the grid attaches to a row (id + parentId + name). */
function dragData(id: string): DragData {
  const row = rows.find((candidate) => candidate.id === id)!;
  return { id: row.id, parentId: row.parentId, name: row.name };
}

function fakeClient(execute = vi.fn(async () => ({ revision: "8", replayed: false }))): ProjectApiClient {
  return {
    load: async () => ({ revision: "7", current: project }),
    grid: async () => grid,
    execute,
  };
}

async function ready(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-col="name"]')).not.toBeNull();
    expect(screen.getByTestId("save-state").textContent).toBe("saved");
  });
}

// Design 0003 §C-3 — drag REORDERS within the sibling scope; it never re-parents.
// The drop semantics live in the pure `reorderSiblingCommands` helper (the exact
// commands `onDragEnd` dispatches through the shared batch path), unit-tested
// here over the real projection rows.
describe("reorderSiblingCommands (drag reorder semantics)", () => {
  it("reorders a subtask within its parent, renumbering that sibling group's slots", () => {
    const [first, middle, last] = childrenOfA;
    // Drag the first child onto the last: it lands after the last, and the two it
    // passes shift up one slot — so all three renumber within the group's own
    // sortOrder values (nothing else moves, no re-parenting).
    const commands = reorderSiblingCommands(dragData(first!.id), dragData(last!.id), rows);
    expect(commands).toEqual([
      { type: "task.update", taskId: middle!.id, changes: { sortOrder: first!.sortOrder } },
      { type: "task.update", taskId: last!.id, changes: { sortOrder: middle!.sortOrder } },
      { type: "task.update", taskId: first!.id, changes: { sortOrder: last!.sortOrder } },
    ]);
  });

  it("swaps two adjacent subtasks (drag onto the neighbor renumbers just those two)", () => {
    const [first, second] = childrenOfA;
    const commands = reorderSiblingCommands(dragData(first!.id), dragData(second!.id), rows);
    expect(commands).toEqual([
      { type: "task.update", taskId: second!.id, changes: { sortOrder: first!.sortOrder } },
      { type: "task.update", taskId: first!.id, changes: { sortOrder: second!.sortOrder } },
    ]);
  });

  it("is a no-op when a subtask is dropped outside its own parent (no re-parenting)", () => {
    // Onto a child of a different parent…
    expect(reorderSiblingCommands(dragData(childrenOfA[0]!.id), dragData(childrenOfB[0]!.id), rows)).toEqual([]);
    // …and onto a root: different sibling scope, so nothing moves.
    expect(reorderSiblingCommands(dragData(childrenOfA[0]!.id), dragData(parentB.id), rows)).toEqual([]);
  });

  it("reorders a root (whole subtree) among roots only", () => {
    const commands = reorderSiblingCommands(dragData(parentA.id), dragData(parentB.id), rows);
    // Root A moves after root B; the two roots trade their own sortOrder slots, so
    // A's subtree rides along (it still nests under A by parentId).
    expect(commands).toEqual([
      { type: "task.update", taskId: parentB.id, changes: { sortOrder: parentA.sortOrder } },
      { type: "task.update", taskId: parentA.id, changes: { sortOrder: parentB.sortOrder } },
    ]);
  });

  it("is a no-op when a row is dropped onto itself", () => {
    expect(reorderSiblingCommands(dragData(parentA.id), dragData(parentA.id), rows)).toEqual([]);
    expect(reorderSiblingCommands(dragData(childrenOfA[0]!.id), dragData(childrenOfA[0]!.id), rows)).toEqual([]);
  });
});

describe("App reorder affordances (§C-3)", () => {
  it("hosts the ⠿ drag grip in the No. column and drops the ▲▼ reorder buttons", async () => {
    render(<App client={fakeClient()} />);
    await ready();

    // The ▲▼ per-row reorder buttons are gone entirely.
    expect(document.querySelector('[data-testid="move-up"]')).toBeNull();
    expect(document.querySelector('[data-testid="move-down"]')).toBeNull();

    // Every row (parent and subtask) still carries a ⠿ grip, now hosted in the
    // leftmost No. column so it reads as the row's left-edge affordance.
    for (const id of [parentA.id, childrenOfA[0]!.id]) {
      const grip = document.querySelector(`[data-testid="drag-grip"][data-task-id="${id}"]`);
      expect(grip).not.toBeNull();
      expect(grip!.closest("[data-col]")?.getAttribute("data-col")).toBe("no");
    }
  });
});
