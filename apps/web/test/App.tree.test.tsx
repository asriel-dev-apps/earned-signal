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
import { TaskSchema } from "../src/project-command-contract.js";
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

/**
 * Like `fakeClient`, but actually applies each executed command to its own
 * project copy (via the same `applyProjectCommand` the server runs), so the
 * optimistic-apply → save → reload round trip settles on the mutated state
 * instead of the reload reverting an added row back out.
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

describe("App tree grid (§C-1)", () => {
  it("always renders the tree affordances (chevrons + drag handles) — no flat mode", async () => {
    const { client } = fakeClient();
    render(<App client={client} />);
    await ready();

    // Tree is the only mode: chevrons and drag grips are present from the start,
    // and there is no flat/tree toggle to switch away from it.
    expect(document.querySelector('[data-testid="tree-toggle"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="drag-grip"]')).not.toBeNull();
    expect(screen.queryByTestId("view-mode-flat")).toBeNull();
    expect(screen.queryByTestId("view-mode-tree")).toBeNull();

    // Roots are depth 0, subtasks depth 1 (visible because parents start expanded).
    expect(document.querySelector(`.grid-row[data-row-id="${parentA.id}"]`)?.getAttribute("data-depth")).toBe("0");
    expect(
      document.querySelector(`.grid-row[data-row-id="${childrenOfA[0]!.id}"]`)?.getAttribute("data-depth"),
    ).toBe("1");
  });

  it("collapses and re-expands a parent through its chevron", async () => {
    const { client } = fakeClient();
    render(<App client={client} />);
    await ready();

    // 2 parents + 3 + 3 children, all visible while expanded (drafts excluded).
    const realRows = () => document.querySelectorAll(".grid-row:not(.grid-row--draft)").length;
    const expandedCount = realRows();
    expect(expandedCount).toBe(project.tasks.length);
    expect(document.querySelector(`.grid-row[data-row-id="${childrenOfA[0]!.id}"]`)).not.toBeNull();

    const toggle = document.querySelector(
      `[data-testid="tree-toggle"][data-task-id="${parentA.id}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(toggle);

    await waitFor(() => {
      // Parent A's three children drop out of the visible set.
      expect(document.querySelector(`.grid-row[data-row-id="${childrenOfA[0]!.id}"]`)).toBeNull();
      expect(realRows()).toBe(expandedCount - childrenOfA.length);
    });

    fireEvent.click(
      document.querySelector(`[data-testid="tree-toggle"][data-task-id="${parentA.id}"]`) as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(document.querySelector(`.grid-row[data-row-id="${childrenOfA[0]!.id}"]`)).not.toBeNull();
      expect(realRows()).toBe(expandedCount);
    });
  });

  it("keeps the daily columns and inline editing working (no regression)", async () => {
    const { client, execute } = fakeClient();
    render(<App client={client} />);
    await ready();
    expect(document.querySelector('[data-testid="drag-grip"]')).not.toBeNull();

    // An inline effort (L) edit dispatches task.update.
    const cell = document.querySelector('[data-col="plannedEffortMinutes"]') as HTMLElement;
    fireEvent.doubleClick(cell);
    const editor = cell.querySelector("input.cell-editor") as HTMLInputElement;
    expect(editor).not.toBeNull();
    fireEvent.change(editor, { target: { value: "7" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    // Row 0 is the first root; the inline effort edit routes through
    // executeCommand as task.update (7h = 420 min).
    expect(execute).toHaveBeenCalledWith(
      { type: "task.update", taskId: parentA.id, changes: { plannedEffortMinutes: 420 } },
      "7",
    );
  });

  it("creates a child task from a subtask draft opened via the row ⋯ menu (§C-5)", async () => {
    const { client, execute } = statefulFakeClient(project);
    render(<App client={client} />);
    await ready();

    // Open parent A's ⋯ menu and add an empty child draft under it.
    const menuButton = document.querySelector(
      `[data-testid="row-menu-button"][data-task-id="${parentA.id}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByTestId("row-menu-add-subtask"));

    const draftName = await waitFor(() => {
      const found = document.querySelector(
        `.grid-row--draft[data-draft-parent="${parentA.id}"] [data-col="name"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    fireEvent.doubleClick(draftName);
    const editor = draftName.querySelector("input.cell-editor") as HTMLInputElement;
    fireEvent.change(editor, { target: { value: "New child" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const command = execute.mock.calls[0]![0];
    if (command.type !== "task.add") throw new Error(`expected task.add, got ${command.type}`);
    // Committing the child draft dispatches task.add with the parent's id.
    expect(command.task.parentId).toBe(parentA.id);
    expect(command.task.name).toBe("New child");
    expect(() => TaskSchema.parse(command.task)).not.toThrow();

    // The committed child appears under parent A and the draft is consumed.
    await waitFor(() => {
      expect(document.querySelector(`.grid-row[data-row-id="${command.task.id}"]`)).not.toBeNull();
    });
    expect(document.querySelector(`.grid-row--draft[data-draft-parent="${parentA.id}"]`)).toBeNull();
    // The pre-existing children of A are still present (tree intact).
    for (const child of childrenOfA) {
      expect(document.querySelector(`.grid-row[data-row-id="${child.id}"]`)).not.toBeNull();
    }
  });
});

// Design 0003 §C-7 — a collapsed parent surfaces its subtree's total effort and
// each day's descendant sum; an expanded parent shows nothing extra. A tiny
// engineered seed (1 parent, 2 leaves with known plans) makes the numbers crisp.
const rollupSeed: ProjectState = (() => {
  const base = createDemoProject({ parentCount: 1, subtasksPerParent: 2, memberCount: 2 });
  const tasks = base.tasks.map((task, index) => {
    if (index === 1) {
      return { ...task, plannedEffortMinutes: 180, dailyPlan: { "2026-01-05": 120, "2026-01-06": 60 } };
    }
    if (index === 2) {
      return { ...task, plannedEffortMinutes: 240, dailyPlan: { "2026-01-05": 240 } };
    }
    return task;
  });
  return { ...base, tasks };
})();
const rollupParent = rollupSeed.tasks[0]!; // total leaves: 420m = 7h; 01-05 Σ = 360m = 6h

function rollupClient(): ProjectApiClient {
  return {
    load: async () => ({ revision: "1", current: rollupSeed }),
    grid: async () => projectWbsGrid(rollupSeed),
    execute: async () => ({ revision: "2", replayed: false }),
  };
}

// Reveal the daily column at `dateIndex` (48px each) past the ~2592px of frozen
// meta columns, matching the cross-project suite's scroll approach.
async function revealDailyColumn(dateIndex: number): Promise<void> {
  const scroller = screen.getByTestId("wbs-grid") as HTMLDivElement;
  scroller.scrollLeft = 2592 + dateIndex * 48 - 600;
  fireEvent.scroll(scroller);
  await waitFor(() => {
    expect(document.querySelector("[data-daily-date]")).not.toBeNull();
  });
}

describe("App collapsed-parent rollup (§C-7)", () => {
  it("shows nothing extra on the effort cell while the parent is expanded", async () => {
    render(<App client={rollupClient()} />);
    await ready();

    // Expanded (default): the effort cell shows the parent's own value, and there
    // is no rollup marker.
    const effortCell = document.querySelector(
      `.grid-row[data-row-id="${rollupParent.id}"] [data-col="plannedEffortMinutes"]`,
    ) as HTMLElement;
    expect(effortCell).not.toBeNull();
    expect(effortCell.querySelector('[data-testid="rollup-effort"]')).toBeNull();
  });

  it("rolls up the subtree's total effort and each day's sum once collapsed", async () => {
    render(<App client={rollupClient()} />);
    await ready();

    // Collapse the parent, hiding its two leaves.
    const toggle = document.querySelector(
      `[data-testid="tree-toggle"][data-task-id="${rollupParent.id}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(document.querySelector(`.grid-row[data-row-id="${rollupSeed.tasks[1]!.id}"]`)).toBeNull();
    });

    // 工数(人時) rolls up to Σ leaves = 420m = 7h; 工数(人日) = 7/8 → 0.9.
    const hoursCell = document.querySelector(
      `.grid-row[data-row-id="${rollupParent.id}"] [data-col="plannedEffortMinutes"]`,
    ) as HTMLElement;
    expect(hoursCell.querySelector('[data-testid="rollup-effort"]')?.textContent).toBe("7");
    const daysCell = document.querySelector(
      `.grid-row[data-row-id="${rollupParent.id}"] [data-col="plannedEffortDays"]`,
    ) as HTMLElement;
    expect(daysCell.querySelector('[data-testid="rollup-effort"]')?.textContent).toBe("0.9");

    // Each daily column shows the descendant sum: 2026-01-05 → 120 + 240 = 360m = 6h.
    await revealDailyColumn(0);
    const dayCell = await waitFor(() => {
      const found = document.querySelector(
        `[data-daily-row="${rollupParent.id}"][data-daily-date="2026-01-05"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(dayCell.getAttribute("data-daily-rollup")).toBe("true");
    expect(dayCell.textContent).toBe("6");
    // The rolled-up daily cell is a read-only summary, not an editable plan cell.
    expect(dayCell.getAttribute("aria-readonly")).toBe("true");
  });
});
