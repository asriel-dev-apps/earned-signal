// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { projectWbsGrid, type ProjectState } from "@vecta/application";
import { App } from "../src/App.js";
import { createDemoProject } from "../src/demo-project.js";
import type { ProjectApiClient } from "../src/project-api-client.js";
import {
  detectOverloads,
  externalMinutesFor,
  overloadKey,
  projectLoadByMember,
  synthesizeExternalLoad,
} from "../src/cross-project-load.js";

// Same no-layout shims as App.test.tsx / App.cross-project.test.tsx so both
// virtualizers materialize rows and day columns.
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

// The same engineered seed as App.cross-project.test.tsx: memberCount 3 puts the
// filled leaf on member index 2 — the one the synthesizer loads (index % 7 === 2)
// — so exactly one day (its ~1-in-50 external wave) pushes that member's total
// over the 480-min cap, giving a known member × date overflow.
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
    if (index === 2) return { ...task, dailyPlan: capacityPlan }; // second leaf → member index 2
    return task;
  });
  return { ...base, tasks };
})();

// Preview persistence is gone (Design 0003 §A-1), so inject the engineered seed
// through a read-only connected client. The panel is a pure view-layer derivation
// of the grid rows, so it behaves identically to preview.
function fakeClient(project: ProjectState): ProjectApiClient {
  return {
    load: async () => ({ revision: "1", current: project }),
    grid: async () => projectWbsGrid(project),
    execute: async () => ({ revision: "2", replayed: false }),
  };
}

/** The overloads the panel flags, computed with the exact same seam functions. */
function expectedOverloads(project: ProjectState) {
  const rows = projectWbsGrid(project).rows;
  const days = [...new Set(rows.flatMap((row) => Object.keys(row.dailyPlan)))].sort();
  const external = synthesizeExternalLoad(project.members, days);
  return detectOverloads({ rows, external, members: project.members });
}

/** Index of the first detected overflow date within the sorted plan-day columns. */
function overflowColumnIndex(project: ProjectState): { date: string; index: number } {
  const rows = projectWbsGrid(project).rows;
  const days = [...new Set(rows.flatMap((row) => Object.keys(row.dailyPlan)))].sort();
  const date = expectedOverloads(project)[0]!.date;
  return { date, index: days.indexOf(date) };
}

async function ready(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-col="name"]')).not.toBeNull();
    expect(screen.getByTestId("save-state").textContent).toBe("saved");
  });
}

// Daily columns sit past the ~2592px of frozen meta columns; reveal the column at
// `dateIndex` (48px each) by scrolling it into the ~1440px viewport. The panel
// reuses the grid's day virtualizer, so scrolling the grid reveals the matching
// panel column too.
async function revealDailyColumn(dateIndex: number): Promise<void> {
  const scroller = screen.getByTestId("wbs-grid") as HTMLDivElement;
  scroller.scrollLeft = 2592 + dateIndex * 48 - 600;
  fireEvent.scroll(scroller);
  await waitFor(() => {
    expect(document.querySelector("[data-daily-date]")).not.toBeNull();
  });
}

function openPanel(): void {
  fireEvent.click(screen.getByTestId("member-panel-toggle"));
}

/** Replica of App's `formatNumber` (integer → plain, else one decimal). */
function fmt(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

describe("App member daily-total panel (Design 0003 §G-1)", () => {
  it("has a guaranteed, non-empty overflow scenario in the seed (self-check)", () => {
    const overloads = expectedOverloads(seed);
    expect(overloads.length).toBeGreaterThan(0);
    // The overflow genuinely includes cross-project load (else the sum assertion
    // below would not distinguish this-project-only from this-project + other-PJ).
    expect(overloads[0]!.externalMinutes).toBeGreaterThan(0);
  });

  it("toggles closed↔open and renders one row per project member when open", async () => {
    render(<App client={fakeClient(seed)} />);
    await ready();

    // Closed by default: the toggle is present, the scroll body is not.
    expect(screen.getByTestId("member-panel-toggle")).toBeTruthy();
    expect(screen.queryByTestId("member-panel-scroll")).toBeNull();

    openPanel();
    expect(screen.getByTestId("member-panel-scroll")).toBeTruthy();
    expect(screen.getAllByTestId("member-row").length).toBe(seed.members.length);
    for (const member of seed.members) {
      expect(
        document.querySelector(`[data-testid="member-row"][data-member-id="${member.id}"]`),
      ).not.toBeNull();
    }

    // Toggling again closes it.
    fireEvent.click(screen.getByTestId("member-panel-toggle"));
    expect(screen.queryByTestId("member-panel-scroll")).toBeNull();
  });

  it("sums this-project dailyPlan + cross-project ExternalLoad per member/day and flags overflow", async () => {
    render(<App client={fakeClient(seed)} />);
    await ready();
    openPanel();

    const { date, index } = overflowColumnIndex(seed);
    await revealDailyColumn(index);

    const overload = expectedOverloads(seed)[0]!;
    const memberId = overload.memberId;

    // The overflow cell exists, carries the red flag, and shows the TOTAL hours —
    // this-project minutes plus the member's other-project load that day.
    const cellSelector = `[data-member-row="${memberId}"][data-member-date="${date}"]`;
    await waitFor(() => {
      expect(document.querySelector(cellSelector)).not.toBeNull();
    });
    const cell = document.querySelector(cellSelector)!;
    expect(cell.getAttribute("data-member-overload")).toBe("true");
    expect(cell.className).toContain("member-day-cell--overload");
    const shownHours = cell.querySelector(".member-day-value")!.textContent;
    expect(shownHours).toBe(fmt(overload.totalMinutes / 60));
    // The shown total exceeds the this-project-only figure, proving ExternalLoad
    // is included in the sum (not just the grid's daily plan).
    expect(overload.totalMinutes).toBeGreaterThan(overload.projectMinutes);

    // Every panel cell's shown hours equals Σ this-project dailyPlan + external,
    // and the overflow flag matches the shared detector — checked against every
    // rendered member on the revealed column.
    const external = synthesizeExternalLoad(
      seed.members,
      [...new Set(projectWbsGrid(seed).rows.flatMap((r) => Object.keys(r.dailyPlan)))].sort(),
    );
    const perMember = projectLoadByMember(projectWbsGrid(seed).rows);
    for (const member of seed.members) {
      const memberCell = document.querySelector(
        `[data-member-row="${member.id}"][data-member-date="${date}"]`,
      );
      if (memberCell === null) continue;
      const projectMinutes = perMember.get(member.id)?.get(date) ?? 0;
      const total = projectMinutes + externalMinutesFor(external, member.id, date);
      const text = memberCell.querySelector(".member-day-value")!.textContent ?? "";
      expect(text).toBe(total > 0 ? fmt(total / 60) : "");
      const flagged = memberCell.getAttribute("data-member-overload") === "true";
      expect(flagged).toBe(new Set(expectedOverloads(seed).map((e) => overloadKey(e.memberId, e.date))).has(overloadKey(member.id, date)));
    }

    // A member with no assignment that day (member index 0 owns no leaf) shows an
    // empty, unflagged cell — the sum is genuinely per-member.
    const idleCell = document.querySelector(
      `[data-member-row="${seed.members[0]!.id}"][data-member-date="${date}"]`,
    );
    expect(idleCell).not.toBeNull();
    expect(idleCell!.querySelector(".member-day-value")!.textContent).toBe("");
    expect(idleCell!.getAttribute("data-member-overload")).toBeNull();
  });
});
