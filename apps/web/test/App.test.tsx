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

/**
 * A fake client that actually applies each executed command to its own
 * project copy (via the same `applyProjectCommand` the server runs) and
 * serves it back from `load`/`grid`. Unlike `fakeClient` (which always serves
 * the static fixture), this lets a test assert on the settled state after the
 * optimistic-apply → save → reload round trip, with no risk of the reload
 * reverting an added/edited row back out.
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

describe("App WBS grid", () => {
  it("renders the meta headers, the rollup, and virtualized task rows", async () => {
    const { client } = fakeClient();
    render(<App client={client} />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-col="name"]').length).toBeGreaterThan(0);
    });

    expect(screen.getByText("タスク・サブタスク")).toBeTruthy();
    expect(screen.getByText("進捗率")).toBeTruthy();
    expect(screen.getByTestId("rollup")).toBeTruthy();
    // BAC/PV/EV/AC/SV/CV/SPI/CPI totals cells.
    expect(screen.getByTestId("rollup").querySelectorAll(".rollup-metric").length).toBe(8);
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

  it("dispatches task.generateSubtasks via the row ⋯ menu for the chosen template", async () => {
    const { client, execute } = fakeClient();
    render(<App client={client} />);

    await waitFor(() => {
      expect(document.querySelector('[data-col="name"]')).not.toBeNull();
      expect(screen.getByTestId("save-state").textContent).toBe("saved");
    });

    // Open the first (parent) row's ⋯ menu, drill into the template list, and pick
    // the first project template (§E-1: resolved from project.templates, not a
    // builtin catalog) — the same command the old toolbar "サブタスク生成" button sent.
    const templateId = project.templates[0]!.id;
    const menuButton = document.querySelector(
      `[data-testid="row-menu-button"][data-task-id="${project.tasks[0]!.id}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByTestId("row-menu-templates"));
    const templateItem = document.querySelector(
      `[data-testid="row-menu-template"][data-template-id="${templateId}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(templateItem);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(
      { type: "task.generateSubtasks", parentTaskId: project.tasks[0]!.id, templateId },
      "7",
    );
    // The menu closes after a template is chosen.
    expect(screen.queryByTestId("row-menu")).toBeNull();
  });

});

describe("App tail draft rows (§C-4)", () => {
  it("commits a name typed into the tail draft and dispatches task.add as a root task", async () => {
    const { client, execute } = statefulFakeClient(project);
    render(<App client={client} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="draft-row"]')).not.toBeNull();
      expect(screen.getByTestId("save-state").textContent).toBe("saved");
    });
    const initialRowCount = document.querySelectorAll(".grid-row:not(.grid-row--draft)").length;

    // Type a name into the tail draft's name cell and commit it — that turns the
    // draft into a real root task (parentId null, sortOrder = max+1).
    const draftName = document.querySelector('.grid-row--draft [data-col="name"]') as HTMLElement;
    fireEvent.doubleClick(draftName);
    const editor = draftName.querySelector("input.cell-editor") as HTMLInputElement;
    expect(editor).not.toBeNull();
    fireEvent.change(editor, { target: { value: "Fresh task" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const command = execute.mock.calls[0]![0];
    if (command.type !== "task.add") throw new Error(`expected task.add, got ${command.type}`);
    expect(command.task.parentId).toBeNull();
    expect(command.task.name).toBe("Fresh task");
    // Appended after every existing sortOrder (0..project.tasks.length-1).
    expect(command.task.sortOrder).toBe(project.tasks.length);
    // The dispatched payload is a fully-populated, schema-valid ProjectTask.
    expect(() => TaskSchema.parse(command.task)).not.toThrow();

    await waitFor(() => {
      expect(document.querySelectorAll(".grid-row:not(.grid-row--draft)").length).toBe(initialRowCount + 1);
    });
    // The new row is selected (name column) so it is ready for further editing.
    const newRow = document.querySelector(`.grid-row[data-row-id="${command.task.id}"]`);
    expect(newRow).not.toBeNull();
    expect(newRow!.querySelector('[data-col="name"]')?.className).toContain("cell--selected");
    // A tail draft still remains after the commit.
    expect(document.querySelector('[data-testid="draft-row"]')).not.toBeNull();
  });

  it("adds a root task with sortOrder 0 when the project has no rows yet", async () => {
    const empty = createDemoProject({ parentCount: 0, subtasksPerParent: 0, memberCount: 0 });
    const { client, execute } = statefulFakeClient(empty);
    render(<App client={client} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="draft-row"]')).not.toBeNull();
      expect(screen.getByTestId("save-state").textContent).toBe("saved");
    });

    const draftName = document.querySelector('.grid-row--draft [data-col="name"]') as HTMLElement;
    fireEvent.doubleClick(draftName);
    const editor = draftName.querySelector("input.cell-editor") as HTMLInputElement;
    fireEvent.change(editor, { target: { value: "First task" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const command = execute.mock.calls[0]![0];
    if (command.type !== "task.add") throw new Error(`expected task.add, got ${command.type}`);
    expect(command.task.parentId).toBeNull();
    expect(command.task.sortOrder).toBe(0);
    expect(() => TaskSchema.parse(command.task)).not.toThrow();

    await waitFor(() => {
      expect(document.querySelectorAll(".grid-row:not(.grid-row--draft)").length).toBe(1);
    });
  });

  it("grows the tail draft rows by n through the + 行追加 control", async () => {
    const { client } = fakeClient();
    render(<App client={client} />);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="draft-row"]')).not.toBeNull();
      expect(screen.getByTestId("save-state").textContent).toBe("saved");
    });

    // Default: exactly one tail draft.
    expect(document.querySelectorAll('[data-testid="draft-row"]').length).toBe(1);

    const countInput = screen.getByTestId("add-rows-count") as HTMLInputElement;
    fireEvent.change(countInput, { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("add-rows-button"));

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="draft-row"]').length).toBe(4);
    });
  });
});

describe("App daily-plan hand editing (Design 0003 §C-2)", () => {
  // There is no lock concept anymore: every working-day daily cell is hand-edited
  // directly. The seeded fixture's first leaf is the deterministic showcase row
  // with a known early-January plan starting 2026-01-05.
  const showcaseLeaf = project.tasks[1]!;

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

  it("has no lock column or lock toggle control", async () => {
    const { client } = fakeClient();
    render(<App client={client} />);
    await ready();
    expect(document.querySelector('[data-testid="lock-toggle"]')).toBeNull();
    expect(document.querySelector('[data-col="lock"]')).toBeNull();
  });

  it("edits a working-day leaf cell directly and dispatches a task.update with the new plan and no lock flag", async () => {
    const { client, execute } = fakeClient();
    render(<App client={client} />);
    await ready();
    await revealDailyColumns();

    const cell = await waitFor(() => {
      const found = document.querySelector(
        `[data-daily-row="${showcaseLeaf.id}"][data-daily-date="2026-01-05"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // Working day ⇒ editable (no aria-readonly), an inline editor opens.
    expect(cell.getAttribute("aria-readonly")).toBeNull();
    fireEvent.doubleClick(cell);
    const editor = cell.querySelector("input.daily-cell-editor") as HTMLInputElement;
    expect(editor).not.toBeNull();
    fireEvent.change(editor, { target: { value: "5" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    // The edit writes the full replacement plan (01-05 → 5h = 300m, other days
    // verbatim) with NO dailyPlanLocked — every daily cell is hand-edited now.
    expect(execute).toHaveBeenCalledWith(
      {
        type: "task.update",
        taskId: showcaseLeaf.id,
        changes: {
          dailyPlan: {
            "2026-01-05": 300,
            "2026-01-06": 240,
            "2026-01-07": 180,
            "2026-01-09": 120,
          },
        },
      },
      "7",
    );
  });

  it("greys and freezes a leaf cell on a shared holiday, keeping its value visible", async () => {
    const { client, execute } = fakeClient();
    render(<App client={client} />);
    await ready();
    await revealDailyColumns();

    // 2026-01-07 is a default-calendar holiday. The showcase leaf plans 3h (180m)
    // there, but the cell is greyed and non-editable — the planned value stays
    // visible (only editing is blocked, per §B-5).
    const cell = await waitFor(() => {
      const found = document.querySelector(
        `[data-daily-row="${showcaseLeaf.id}"][data-daily-date="2026-01-07"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(cell.className).toContain("daily-cell--nonworking");
    expect(cell.getAttribute("aria-readonly")).toBe("true");
    expect(cell.textContent).toContain("3");
    fireEvent.doubleClick(cell);
    expect(cell.querySelector("input")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("shows a non-blocking row warning when a leaf's estimate disagrees with its daily plot", async () => {
    // Break the showcase leaf's estimate-vs-daily agreement (L ≠ Σ daily) and
    // serve that grid: the row must surface a ⚠ marker in its No. column, and
    // saving is never prevented (the warning is advisory only).
    const mismatched: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) =>
        task.id === showcaseLeaf.id
          ? { ...task, plannedEffortMinutes: task.plannedEffortMinutes + 60 }
          : task,
      ),
    };
    const mismatchedGrid = projectWbsGrid(mismatched);
    const client: ProjectApiClient = {
      load: async () => ({ revision: "7", current: mismatched }),
      grid: async () => mismatchedGrid,
      execute: vi.fn(async () => ({ revision: "8", replayed: false })),
    };
    render(<App client={client} />);
    await ready();

    const warning = await waitFor(() => {
      const found = document.querySelector(
        `[data-testid="row-warning"][data-task-id="${showcaseLeaf.id}"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(warning.getAttribute("title")).toContain("日別計画");
  });
});
