// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { projectWbsGrid, type ProjectState } from "@vecta/application";
import { App, PREVIEW_STORAGE_KEY, PREVIEW_STORAGE_VERSION } from "../src/App.js";
import { createDemoProject } from "../src/demo-project.js";
import {
  detectOverloads,
  overloadKey,
  synthesizeExternalLoad,
} from "../src/cross-project-load.js";

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

// A small preview project engineered so a cross-project overflow is guaranteed
// and confined to a known day column, even under the (sparse) synthesizer.
// createDemoProject(memberCount:3) assigns the *second* leaf to member index 2 —
// the member the synthesizer loads (index % 7 === 2). Filling that leaf to
// capacity (480/day) across a 50-working-day block means the one day the
// synthesizer lands other-project minutes on that member (its ~1-in-50 wave)
// pushes the total over the 480 cap. The block spans enough days to include that
// single external day; nothing else in the seed carries a plan.
function workingDays(start: string, count: number): string[] {
  const out: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  while (out.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

const seed: ProjectState = (() => {
  const base = createDemoProject({ parentCount: 1, subtasksPerParent: 2, memberCount: 3 });
  const capacityPlan: Record<string, number> = {};
  for (const date of workingDays("2026-01-05", 50)) capacityPlan[date] = 480;
  const tasks = base.tasks.map((task, index) => {
    if (index === 1) return { ...task, dailyPlan: {} }; // first leaf: no plan
    if (index === 2) {
      // Second leaf → assignee is member index 2 (the synthesizer's loaded member).
      return { ...task, dailyPlan: capacityPlan };
    }
    return task;
  });
  return { ...base, tasks };
})();

function seedStorage(project: ProjectState): void {
  localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify({ version: PREVIEW_STORAGE_VERSION, project }));
}

/** The overloads App will detect, computed with the exact same seam functions. */
function expectedOverloads(project: ProjectState) {
  const rows = projectWbsGrid(project).rows;
  const days = [...new Set(rows.flatMap((row) => Object.keys(row.dailyPlan)))].sort();
  const external = synthesizeExternalLoad(project.members, days);
  return detectOverloads({ rows, external, members: project.members });
}

async function ready(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-col="name"]')).not.toBeNull();
    expect(screen.getByTestId("save-state").textContent).toBe("preview");
  });
}

// Daily columns sit past the ~2592px of frozen meta columns; reveal the column
// at `dateIndex` (48px each) by scrolling it into the ~1440px viewport.
async function revealDailyColumn(dateIndex: number): Promise<void> {
  const scroller = screen.getByTestId("wbs-grid") as HTMLDivElement;
  scroller.scrollLeft = 2592 + dateIndex * 48 - 600;
  fireEvent.scroll(scroller);
  await waitFor(() => {
    expect(document.querySelector("[data-daily-date]")).not.toBeNull();
  });
}

/** Index of the first detected overflow date within the sorted day columns. */
function overflowColumnIndex(project: ProjectState): { date: string; index: number } {
  const rows = projectWbsGrid(project).rows;
  const days = [...new Set(rows.flatMap((row) => Object.keys(row.dailyPlan)))].sort();
  const date = expectedOverloads(project)[0]!.date;
  return { date, index: days.indexOf(date) };
}

describe("App cross-project load overlay + overflow alert", () => {
  it("has a guaranteed, non-empty overflow scenario in the seed (self-check)", () => {
    const overloads = expectedOverloads(seed);
    expect(overloads.length).toBeGreaterThan(0);
  });

  it("overlays the assignee's other-project load and highlights the overflow day cells", async () => {
    seedStorage(seed);
    render(<App />);
    await ready();
    const { date, index } = overflowColumnIndex(seed);
    await revealDailyColumn(index);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="daily-load-overlay"]').length).toBeGreaterThan(0);
    });

    // The filled leaf's assignee (member index 2) is overloaded on the detected
    // day: its cell carries the overload flag and an overlay bar.
    const leafRow = seed.tasks[2]!; // assignee = member index 2 (loaded)
    const cell = document.querySelector(
      `[data-daily-row="${leafRow.id}"][data-daily-date="${date}"]`,
    );
    expect(cell).not.toBeNull();
    expect(cell!.getAttribute("data-overload")).toBe("true");
    expect(cell!.querySelector('[data-testid="daily-load-overlay"]')).not.toBeNull();

    // Every rendered overload cell corresponds to a detected (member, date) pair.
    const overloadKeys = new Set(
      expectedOverloads(seed).map((entry) => overloadKey(entry.memberId, entry.date)),
    );
    for (const overloadCell of document.querySelectorAll('[data-overload="true"]')) {
      const cellDate = overloadCell.getAttribute("data-daily-date")!;
      expect(overloadKeys.has(overloadKey(leafRow.assigneeMemberId!, cellDate))).toBe(true);
    }

    // The overlay is always on now (§D-1): there is no toggle to hide it.
    expect(screen.queryByTestId("toggle-external-load")).toBeNull();
    expect(screen.queryByTestId("overload-summary")).toBeNull();
  });
});
