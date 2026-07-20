// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProjectState } from "@vecta/application";
import { App, PREVIEW_STORAGE_KEY, PREVIEW_STORAGE_VERSION } from "../src/App.js";
import { createDemoProject } from "../src/demo-project.js";

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

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

// A tiny, distinctly-named fixture so its rows are never confused with the
// (much larger) default demo baseline's own row names.
const seed: ProjectState = (() => {
  const base = createDemoProject({ parentCount: 1, subtasksPerParent: 1, memberCount: 1 });
  return {
    ...base,
    tasks: base.tasks.map((task) =>
      task.parentId === null ? { ...task, name: "Seeded root task" } : { ...task, name: "Seeded child task" },
    ),
  };
})();

function seedStorage(project: ProjectState): void {
  localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify({ version: PREVIEW_STORAGE_VERSION, project }));
}

async function ready(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-col="name"]')).not.toBeNull();
    expect(screen.getByTestId("save-state").textContent).toBe("preview");
  });
}

describe("App preview localStorage persistence", () => {
  it("restores a previously-saved preview project instead of the demo baseline", async () => {
    seedStorage(seed);
    render(<App />);
    await ready();

    expect(screen.getByText("Seeded root task")).toBeTruthy();
    expect(screen.getByText("Seeded child task")).toBeTruthy();
    expect(document.querySelectorAll(".grid-row").length).toBe(seed.tasks.length);
  });

  it("falls back to the demo baseline when nothing is stored yet", async () => {
    render(<App />);
    await ready();

    expect(screen.getByText("Phase A deliverable 1")).toBeTruthy();
    expect(document.querySelector(".grid-row")).not.toBeNull();
  });

  it("falls back to the demo baseline without crashing when the stored payload is corrupt JSON", async () => {
    localStorage.setItem(PREVIEW_STORAGE_KEY, "{not valid json");
    render(<App />);
    await ready();

    expect(screen.getByText("Phase A deliverable 1")).toBeTruthy();
  });

  it("falls back to the demo baseline when the stored payload's version doesn't match", async () => {
    localStorage.setItem(
      PREVIEW_STORAGE_KEY,
      JSON.stringify({ version: PREVIEW_STORAGE_VERSION + 1, project: seed }),
    );
    render(<App />);
    await ready();

    expect(screen.getByText("Phase A deliverable 1")).toBeTruthy();
  });

  it("persists an Add-task + inline name edit across a simulated reload (unmount/remount)", async () => {
    seedStorage(seed);
    const { unmount } = render(<App />);
    await ready();

    fireEvent.click(screen.getByTestId("add-task"));
    await waitFor(() => {
      expect(document.querySelectorAll(".grid-row").length).toBe(seed.tasks.length + 1);
    });

    // The newly-added row is selected on its name column; rename it through
    // the same inline-editor path as every other edit.
    const nameCell = document.querySelector(".cell--selected[data-col='name']") as HTMLElement;
    expect(nameCell).not.toBeNull();
    fireEvent.doubleClick(nameCell);
    const editor = nameCell.querySelector("input.cell-editor") as HTMLInputElement;
    expect(editor).not.toBeNull();
    fireEvent.change(editor, { target: { value: "Persisted task" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(screen.getByText("Persisted task")).toBeTruthy());

    unmount();

    // A fresh mount re-reads localStorage exactly like a page reload would.
    render(<App />);
    await ready();
    expect(screen.getByText("Persisted task")).toBeTruthy();
    expect(document.querySelectorAll(".grid-row").length).toBe(seed.tasks.length + 1);
  });

  it("clears storage and restores the demo baseline via Reset to demo", async () => {
    seedStorage(seed);
    render(<App />);
    await ready();
    expect(document.querySelectorAll(".grid-row").length).toBe(seed.tasks.length);

    fireEvent.click(screen.getByTestId("reset-to-demo"));

    await waitFor(() => {
      expect(screen.getByText("Phase A deliverable 1")).toBeTruthy();
    });
    expect(document.querySelector(".grid-row")).not.toBeNull();
    expect(localStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull();
  });

  it("does not render Reset to demo, and never writes localStorage, in connected mode", async () => {
    const client = {
      load: async () => ({ revision: "1", current: seed }),
      grid: async () => ({
        projectId: seed.id,
        statusDate: seed.statusDate,
        rows: [],
        rollup: { bac: 0, pv: 0, ev: 0, ac: 0, sv: 0, cv: 0, spi: "-" as const, cpi: "-" as const },
      }),
      execute: async () => ({ revision: "2", replayed: false }),
    };
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toBe("saved"));

    expect(document.querySelector('[data-testid="reset-to-demo"]')).toBeNull();
    expect(localStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull();
  });
});
