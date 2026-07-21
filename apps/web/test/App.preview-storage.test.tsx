// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProjectState } from "@vecta/application";
import { App } from "../src/App.js";
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

// A tiny fixture the connected fake client serves back through load/grid.
const seed: ProjectState = createDemoProject({ parentCount: 1, subtasksPerParent: 1, memberCount: 1 });

async function ready(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-col="name"]')).not.toBeNull();
    expect(screen.getByTestId("save-state").textContent).toBe("preview");
  });
}

// Preview persistence was removed in Design 0003 §A-1: the demo grid is
// dev/local-only and its edits are ephemeral. Neither mode mirrors state to
// localStorage — a reload simply restores the fresh demo baseline (preview) or
// the server's project (connected).
describe("App state is never mirrored to localStorage", () => {
  it("does not persist a preview edit to localStorage", async () => {
    render(<App />);
    await ready();

    // Edit a visible cell — that mutates the in-memory preview project through the
    // exact path (executeCommands) that previously mirrored to localStorage.
    const nameCell = document.querySelector(
      '.grid-row:not(.grid-row--draft) [data-col="name"]',
    ) as HTMLElement;
    expect(nameCell).not.toBeNull();
    fireEvent.doubleClick(nameCell);
    const editor = nameCell.querySelector("input.cell-editor") as HTMLInputElement;
    expect(editor).not.toBeNull();
    fireEvent.change(editor, { target: { value: "Renamed in preview" } });
    fireEvent.blur(editor);

    await waitFor(() => expect(screen.getByText("Renamed in preview")).toBeTruthy());
    expect(localStorage.length).toBe(0);
  });

  it("never writes localStorage in connected mode", async () => {
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

    expect(localStorage.length).toBe(0);
  });
});
