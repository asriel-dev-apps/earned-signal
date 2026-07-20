// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { projectWbsGrid, type ProjectState } from "@earned-signal/application";
import { App } from "../src/App.js";
import { createDemoProject } from "../src/demo-project.js";
import type { ProjectApiClient } from "../src/project-api-client.js";

// TanStack Virtual measures the scroll element via offsetWidth/offsetHeight and
// a ResizeObserver; happy-dom performs no layout, so give elements a size and
// stub the observer to let the row/column virtualizers produce items.
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

const project: ProjectState = createDemoProject({ parentCount: 1, subtasksPerParent: 3, memberCount: 2 });
const grid = projectWbsGrid(project);

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

describe("App WBS grid", () => {
  it("renders the 23 meta headers, the rollup, and virtualized task rows", async () => {
    const { client } = fakeClient();
    render(<App client={client} />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-col="name"]').length).toBeGreaterThan(0);
    });

    expect(screen.getByText("Task / Subtask")).toBeTruthy();
    expect(screen.getByText("Progress")).toBeTruthy();
    expect(screen.getByTestId("rollup")).toBeTruthy();
    // BAC/PV/EV/AC/SV/CV/SPI/CPI tiles.
    expect(screen.getByTestId("rollup").querySelectorAll(".rollup-tile").length).toBe(8);
    expect(screen.getByTestId("save-state").textContent).toBe("saved");
  });

  it("keeps the rendered DOM bounded by the viewport, not by the row count", () => {
    const large = createDemoProject({ parentCount: 60, subtasksPerParent: 9, memberCount: 8 });
    const largeGrid = projectWbsGrid(large);
    const client: ProjectApiClient = {
      load: async () => ({ revision: "1", current: large }),
      grid: async () => largeGrid,
      execute: vi.fn(async () => ({ revision: "2", replayed: false })),
    };
    render(<App client={client} />);
    // 60*10 = 600 logical rows, but virtualization renders only the viewport window.
    return waitFor(() => {
      const rendered = document.querySelectorAll(".grid-row").length;
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(large.tasks.length);
    });
  });

  it("persists an inline effort (L) edit through executeCommand as task.update", async () => {
    const { client, execute } = fakeClient();
    render(<App client={client} />);

    await waitFor(() => {
      expect(document.querySelector('[data-col="plannedEffortMinutes"]')).not.toBeNull();
    });

    const cell = document.querySelector('[data-col="plannedEffortMinutes"]') as HTMLElement;
    fireEvent.doubleClick(cell);
    const editor = cell.querySelector("input.cell-editor") as HTMLInputElement;
    expect(editor).not.toBeNull();
    fireEvent.change(editor, { target: { value: "10" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(
      { type: "task.update", taskId: project.tasks[0]!.id, changes: { plannedEffortMinutes: 600 } },
      "7",
    );
  });
});

describe("App daily-plan lock and hand editing", () => {
  // The seeded fixture makes the first parent unlocked (auto-scheduled) and its
  // first leaf the locked showcase row with a hand plan starting 2026-01-05.
  const parentTask = project.tasks[0]!;
  const lockedLeaf = project.tasks[1]!;
  const unlockedLeaf = project.tasks[2]!;

  async function ready(): Promise<void> {
    await waitFor(() => {
      expect(document.querySelector('[data-col="name"]')).not.toBeNull();
      expect(screen.getByTestId("save-state").textContent).toBe("saved");
    });
  }

  // Daily columns sit past the frozen meta columns, so the horizontal
  // virtualizer only materializes them after a scroll into that region.
  async function revealDailyColumns(): Promise<void> {
    const scroller = screen.getByTestId("wbs-grid") as HTMLDivElement;
    scroller.scrollLeft = 2532;
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(document.querySelector("[data-daily-date]")).not.toBeNull();
    });
  }

  it("seeds a locked showcase leaf and an unlocked (scheduler-owned) parent", () => {
    expect(lockedLeaf.dailyPlanLocked).toBe(true);
    expect(lockedLeaf.dailyPlan["2026-01-05"]).toBe(240);
    expect(parentTask.dailyPlanLocked).toBe(false);
    expect(unlockedLeaf.dailyPlanLocked).toBe(false);
  });

  it("toggles dailyPlanLocked through the lock control as a task.update", async () => {
    const { client, execute } = fakeClient();
    render(<App client={client} />);
    await ready();

    const toggle = document.querySelector(
      `[data-testid="lock-toggle"][data-task-id="${parentTask.id}"]`,
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("data-locked")).toBe("false");
    fireEvent.click(toggle);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(
      { type: "task.update", taskId: parentTask.id, changes: { dailyPlanLocked: true } },
      "7",
    );
  });

  it("keeps an unlocked task's daily cell read-only (no inline editor opens)", async () => {
    const { client, execute } = fakeClient();
    render(<App client={client} />);
    await ready();
    await revealDailyColumns();

    const cell = await waitFor(() => {
      const found = document.querySelector(
        `[data-daily-row="${parentTask.id}"][data-daily-date="2026-01-05"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(cell.getAttribute("aria-readonly")).toBe("true");
    fireEvent.doubleClick(cell);
    expect(cell.querySelector("input")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("hand-edits a locked task's daily cell and re-asserts the lock in the command", async () => {
    const { client, execute } = fakeClient();
    render(<App client={client} />);
    await ready();
    await revealDailyColumns();

    const cell = await waitFor(() => {
      const found = document.querySelector(
        `[data-daily-row="${lockedLeaf.id}"][data-daily-date="2026-01-05"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.doubleClick(cell);
    const editor = cell.querySelector("input.daily-cell-editor") as HTMLInputElement;
    expect(editor).not.toBeNull();
    fireEvent.change(editor, { target: { value: "5" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    // The edit replaces the full plan (01-05 → 5h = 300m, other days verbatim)
    // and re-asserts the lock — the D17 "hand-edit is manual-lock" invariant.
    expect(execute).toHaveBeenCalledWith(
      {
        type: "task.update",
        taskId: lockedLeaf.id,
        changes: {
          dailyPlan: {
            "2026-01-05": 300,
            "2026-01-06": 240,
            "2026-01-07": 180,
            "2026-01-09": 120,
          },
          dailyPlanLocked: true,
        },
      },
      "7",
    );
  });
});
