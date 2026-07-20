// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyProjectCommand,
  projectWbsGrid,
  type ProjectCommand,
  type ProjectState,
} from "@vecta/application";
import { App } from "../src/App.js";
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
const roots = project.tasks.filter((task) => task.parentId === null);
const parentA = roots[0]!;
const parentB = roots[1]!;
const childrenOfA = project.tasks.filter((task) => task.parentId === parentA.id);

/**
 * A fake client that applies each executed command to its own project copy (via
 * the same `applyProjectCommand` the server runs) and serves it back, so the
 * optimistic-apply → save → reload round trip settles on the reordered state.
 */
function statefulFakeClient(seed: ProjectState): {
  readonly client: ProjectApiClient;
  readonly execute: ReturnType<typeof vi.fn<(command: ProjectCommand, revision: string) => Promise<{ revision: string; replayed: boolean }>>>;
} {
  let current = seed;
  let revisionCounter = 7;
  const execute = vi.fn(async (command: ProjectCommand) => {
    current = applyProjectCommand(current, command);
    revisionCounter += 1;
    return { revision: String(revisionCounter), replayed: false };
  });
  const client: ProjectApiClient = {
    load: async () => ({ revision: String(revisionCounter), current }),
    grid: async () => projectWbsGrid(current),
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

function rowOrder(): string[] {
  return Array.from(document.querySelectorAll(".grid-row")).map(
    (row) => row.getAttribute("data-row-id") ?? "",
  );
}

function moveButton(direction: "up" | "down", taskId: string): HTMLButtonElement {
  return document.querySelector(
    `[data-testid="move-${direction}"][data-task-id="${taskId}"]`,
  ) as HTMLButtonElement;
}

describe("App sibling reorder", () => {
  it("swaps two child siblings' sortOrder via the down control and reorders the grid", async () => {
    const { client, execute } = statefulFakeClient(project);
    render(<App client={client} />);
    await ready();

    const first = childrenOfA[0]!;
    const second = childrenOfA[1]!;
    // Before: first child precedes the second among parent A's children.
    expect(rowOrder().indexOf(first.id)).toBeLessThan(rowOrder().indexOf(second.id));

    fireEvent.click(moveButton("down", first.id));

    // A single click dispatches the two-command swap: each row takes the other's
    // sortOrder (a true exchange), leaving every other row's order untouched.
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls[0]![0]).toEqual({
      type: "task.update",
      taskId: first.id,
      changes: { sortOrder: second.sortOrder },
    });
    expect(execute.mock.calls[1]![0]).toEqual({
      type: "task.update",
      taskId: second.id,
      changes: { sortOrder: first.sortOrder },
    });

    // After the reload the two siblings have traded places in the grid.
    await waitFor(() => {
      expect(rowOrder().indexOf(second.id)).toBeLessThan(rowOrder().indexOf(first.id));
    });
  });

  it("swaps two child siblings via the up control (mirror of down)", async () => {
    const { client, execute } = statefulFakeClient(project);
    render(<App client={client} />);
    await ready();

    const first = childrenOfA[0]!;
    const second = childrenOfA[1]!;

    fireEvent.click(moveButton("up", second.id));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls[0]![0]).toEqual({
      type: "task.update",
      taskId: second.id,
      changes: { sortOrder: first.sortOrder },
    });
    expect(execute.mock.calls[1]![0]).toEqual({
      type: "task.update",
      taskId: first.id,
      changes: { sortOrder: second.sortOrder },
    });
    await waitFor(() => {
      expect(rowOrder().indexOf(second.id)).toBeLessThan(rowOrder().indexOf(first.id));
    });
  });

  it("disables the reorder controls at the edges of a sibling run", async () => {
    const { client } = statefulFakeClient(project);
    render(<App client={client} />);
    await ready();

    const firstChild = childrenOfA[0]!;
    const lastChild = childrenOfA[childrenOfA.length - 1]!;

    // First/last child: cannot move up/down past its run.
    expect(moveButton("up", firstChild.id).disabled).toBe(true);
    expect(moveButton("down", firstChild.id).disabled).toBe(false);
    expect(moveButton("down", lastChild.id).disabled).toBe(true);
    expect(moveButton("up", lastChild.id).disabled).toBe(false);

    // Root siblings are their own run: first root can't move up, last can't move down.
    expect(moveButton("up", parentA.id).disabled).toBe(true);
    expect(moveButton("down", parentB.id).disabled).toBe(true);
  });

  it("reorders root siblings (and their subtrees) in tree mode", async () => {
    const { client, execute } = statefulFakeClient(project);
    render(<App client={client} />);
    await ready();
    fireEvent.click(screen.getByTestId("view-mode-tree"));
    await waitFor(() => expect(document.querySelector('[data-testid="drag-grip"]')).not.toBeNull());

    // Before: parent A precedes parent B.
    expect(rowOrder().indexOf(parentA.id)).toBeLessThan(rowOrder().indexOf(parentB.id));

    fireEvent.click(moveButton("down", parentA.id));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    // After the swap the tree nests B's and A's subtrees under the new root order,
    // so B (with its children) now precedes A.
    await waitFor(() => {
      const order = rowOrder();
      expect(order.indexOf(parentB.id)).toBeLessThan(order.indexOf(parentA.id));
      // A's children still nest under A (subtree moved with it, not orphaned).
      expect(order.indexOf(parentA.id)).toBeLessThan(order.indexOf(childrenOfA[0]!.id));
    });
  });
});
