import { describe, expect, it } from "vitest";
import type { WbsGridTaskRow } from "@vecta/application";
import {
  detectOverloads,
  projectLoadByMember,
  synthesizeExternalLoad,
  type ExternalLoad,
} from "../src/cross-project-load.js";

// The load math reads only `assigneeMemberId` and `dailyPlan`, so a test row is
// just those two fields projected onto the grid-row shape.
function row(assigneeMemberId: string | null, dailyPlan: Record<string, number>): WbsGridTaskRow {
  return { assigneeMemberId, dailyPlan } as unknown as WbsGridTaskRow;
}

const members = [
  { id: "m1", dailyCapacityMinutes: 480 },
  { id: "m2", dailyCapacityMinutes: 480 },
];

describe("synthesizeExternalLoad", () => {
  // Enough members that a couple fall on the ~1-in-7 shared cadence, and enough
  // dates that the sparse ~1-in-50 wave lands at least once for them.
  const memberFixtures = Array.from({ length: 15 }, (_, index) => ({
    id: `member-${index}`,
    dailyCapacityMinutes: 480,
  }));
  const dates = Array.from({ length: 60 }, (_, index) => {
    const day = index + 1;
    return `2026-${day <= 28 ? "02" : "03"}-${String(day <= 28 ? day : day - 28).padStart(2, "0")}`;
  });

  it("is deterministic — identical inputs yield a deeply-equal fixture (no Date.now/random)", () => {
    const first = synthesizeExternalLoad(memberFixtures, dates);
    const second = synthesizeExternalLoad(memberFixtures, dates);
    expect(second).toEqual(first);
  });

  it("is selective — only a subset of members carry load, none is the full roster", () => {
    const load = synthesizeExternalLoad(memberFixtures, dates);
    const loaded = Object.keys(load);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.length).toBeLessThan(memberFixtures.length);
  });

  it("is sparse — a shared member is loaded on only a small fraction of days", () => {
    const load = synthesizeExternalLoad(memberFixtures, dates);
    for (const perDate of Object.values(load)) {
      // ~1 in 50 days; well under a tenth of a 60-day window.
      expect(Object.keys(perDate).length).toBeLessThanOrEqual(dates.length / 10);
    }
  });

  it("keeps every synthesized value within 120–240 and never above capacity", () => {
    const load = synthesizeExternalLoad(memberFixtures, dates);
    for (const perDate of Object.values(load)) {
      for (const minutes of Object.values(perDate)) {
        expect(minutes).toBeGreaterThanOrEqual(120);
        expect(minutes).toBeLessThanOrEqual(240);
      }
    }
  });

  it("excludes members whose capacity is absent (GENERAL read model)", () => {
    // Same positions as memberFixtures but capacity stripped; nothing is emitted
    // because a member without a known capacity cannot be range-checked.
    const stripped = memberFixtures.map((member) => ({ id: member.id }));
    const load = synthesizeExternalLoad(stripped, dates);
    expect(Object.keys(load)).toHaveLength(0);
  });
});

describe("projectLoadByMember", () => {
  it("sums a member's plan across every task they own on the same day and ignores unassigned tasks", () => {
    const rows = [
      row("m1", { "2026-02-02": 180 }),
      row("m1", { "2026-02-02": 120, "2026-02-03": 60 }),
      row(null, { "2026-02-02": 999 }),
    ];
    const load = projectLoadByMember(rows);
    expect(load.get("m1")?.get("2026-02-02")).toBe(300);
    expect(load.get("m1")?.get("2026-02-03")).toBe(60);
    expect(load.has(null as unknown as string)).toBe(false);
  });
});

describe("detectOverloads", () => {
  it("flags a day only when this-project + other-project total strictly exceeds capacity (boundary)", () => {
    // m1: project 300 + external 180 = 480 == capacity → NOT an overflow.
    // m2: project 300 + external 181 = 481 == capacity + 1 → overflow.
    const rows = [row("m1", { "2026-02-02": 300 }), row("m2", { "2026-02-02": 300 })];
    const external: ExternalLoad = {
      m1: { "2026-02-02": 180 },
      m2: { "2026-02-02": 181 },
    };
    const overloads = detectOverloads({ rows, external, members });
    expect(overloads).toHaveLength(1);
    expect(overloads[0]).toMatchObject({
      memberId: "m2",
      date: "2026-02-02",
      projectMinutes: 300,
      externalMinutes: 181,
      totalMinutes: 481,
      capacityMinutes: 480,
      overflowMinutes: 1,
    });
  });

  it("stacks multiple same-day tasks before comparing to capacity", () => {
    // Two m1 tasks (240 + 180 = 420) + external 120 = 540 > 480 → overflow of 60.
    const rows = [row("m1", { "2026-02-05": 240 }), row("m1", { "2026-02-05": 180 })];
    const external: ExternalLoad = { m1: { "2026-02-05": 120 } };
    const overloads = detectOverloads({ rows, external, members });
    expect(overloads).toHaveLength(1);
    expect(overloads[0]).toMatchObject({ projectMinutes: 420, overflowMinutes: 60 });
  });

  it("detects overflow driven entirely by other-project load", () => {
    const rows = [row("m1", { "2026-02-06": 120 })];
    const external: ExternalLoad = { m1: { "2026-02-06": 400 } };
    const overloads = detectOverloads({ rows, external, members });
    expect(overloads).toHaveLength(1);
    expect(overloads[0]).toMatchObject({ totalMinutes: 520, overflowMinutes: 40 });
  });

  it("ignores unassigned tasks and members without a known capacity", () => {
    const rows = [
      row(null, { "2026-02-02": 900 }),
      row("m3", { "2026-02-02": 900 }),
    ];
    const external: ExternalLoad = { m3: { "2026-02-02": 900 } };
    // m3 has no capacity in the roster, so it is never range-checked.
    const overloads = detectOverloads({ rows, external, members });
    expect(overloads).toHaveLength(0);
  });

  it("sorts the worst overflow first", () => {
    const rows = [row("m1", { "2026-02-02": 480 }), row("m2", { "2026-02-03": 480 })];
    const external: ExternalLoad = {
      m1: { "2026-02-02": 60 }, // over by 60
      m2: { "2026-02-03": 240 }, // over by 240
    };
    const overloads = detectOverloads({ rows, external, members });
    expect(overloads.map((entry) => entry.overflowMinutes)).toEqual([240, 60]);
  });
});
