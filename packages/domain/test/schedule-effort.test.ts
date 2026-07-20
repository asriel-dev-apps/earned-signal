import { describe, expect, it } from "vitest";
import {
  calculateTaskEffort,
  DEFAULT_DAILY_CAPACITY_MINUTES,
  scheduleEffortDailyPlans,
  ScheduleCycleError,
  type EffortScheduleCalendarInput,
  type EffortScheduleDependencyInput,
  type EffortScheduleInput,
  type EffortScheduleMemberInput,
  type EffortScheduleTaskInput,
} from "../src/index.js";

// Golden values are hand-derived from the ADR 0011 §12 placement rules on
// synthetic inputs. 2026-01-05 is a Monday; the "standard" calendar works
// Mon–Fri. Minutes are integers throughout — no rounding.

const STANDARD: EffortScheduleCalendarInput = {
  id: "standard",
  workingWeekdays: [1, 2, 3, 4, 5],
  nonWorkingDates: [],
};

function member(id: string, dailyCapacityMinutes = 480, calendarId = "standard"): EffortScheduleMemberInput {
  return { id, calendarId, dailyCapacityMinutes };
}

function task(
  id: string,
  overrides: Partial<Omit<EffortScheduleTaskInput, "id">> = {},
): EffortScheduleTaskInput {
  return {
    id,
    sortOrder: overrides.sortOrder ?? 0,
    assigneeMemberId: overrides.assigneeMemberId ?? null,
    plannedEffortMinutes: overrides.plannedEffortMinutes ?? 0,
    dailyPlan: overrides.dailyPlan ?? {},
    fixedDailyPlan: overrides.fixedDailyPlan ?? false,
    dependencies: overrides.dependencies ?? [],
    isLeaf: overrides.isLeaf ?? true,
  };
}

function run(input: Omit<EffortScheduleInput, "projectStart" | "defaultCalendarId" | "calendars"> & {
  readonly projectStart?: string;
  readonly calendars?: readonly EffortScheduleCalendarInput[];
}): Map<string, Readonly<Record<string, number>>> {
  const result = scheduleEffortDailyPlans({
    projectStart: input.projectStart ?? "2026-01-05",
    defaultCalendarId: "standard",
    calendars: input.calendars ?? [STANDARD],
    members: input.members,
    tasks: input.tasks,
  });
  return new Map(result.dailyPlans);
}

const FS = (predecessorId: string, lagWorkingDays = 0): EffortScheduleDependencyInput => ({
  predecessorId,
  type: "FS",
  lagWorkingDays,
});

describe("scheduleEffortDailyPlans", () => {
  it("(1) starts an FS successor after the predecessor finish plus lag", () => {
    // A finishes 01-05. B FS lag 2 ⇒ start = 3 working days after 01-05 = 01-08.
    const plans = run({
      members: [member("m1")],
      tasks: [
        task("A", { sortOrder: 1, assigneeMemberId: "m1", plannedEffortMinutes: 480 }),
        task("B", {
          sortOrder: 2,
          assigneeMemberId: "m1",
          plannedEffortMinutes: 480,
          dependencies: [FS("A", 2)],
        }),
      ],
    });
    expect(plans.get("A")).toEqual({ "2026-01-05": 480 });
    expect(plans.get("B")).toEqual({ "2026-01-08": 480 });
  });

  it("(2) caps a task at the member's daily capacity across working days", () => {
    // 24h against an 8h/day member ⇒ 480 × 3 working days.
    const plans = run({
      members: [member("m1", 480)],
      tasks: [task("T", { assigneeMemberId: "m1", plannedEffortMinutes: 1_440 })],
    });
    expect(plans.get("T")).toEqual({
      "2026-01-05": 480,
      "2026-01-07": 480,
      "2026-01-06": 480,
    });
  });

  it("(3) skips holidays, individual non-working days, and weekends", () => {
    // 01-06 is a holiday; 01-10/11 are the weekend. 2400 min = 480 × 5.
    const plans = run({
      calendars: [{ id: "standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: ["2026-01-06"] }],
      members: [member("m1", 480)],
      tasks: [task("T", { assigneeMemberId: "m1", plannedEffortMinutes: 2_400 })],
    });
    expect(plans.get("T")).toEqual({
      "2026-01-05": 480,
      "2026-01-07": 480,
      "2026-01-08": 480,
      "2026-01-09": 480,
      "2026-01-12": 480,
    });
  });

  it("(4) levels two tasks of the same member across the shared daily budget", () => {
    // Same 8h/day member. T1 (lower sort_order) claims 240 of 01-05; T2 gets the
    // remaining 240 of 01-05 then spills 240 into 01-06.
    const plans = run({
      members: [member("m1", 480)],
      tasks: [
        task("T1", { sortOrder: 1, assigneeMemberId: "m1", plannedEffortMinutes: 240 }),
        task("T2", { sortOrder: 2, assigneeMemberId: "m1", plannedEffortMinutes: 480 }),
      ],
    });
    expect(plans.get("T1")).toEqual({ "2026-01-05": 240 });
    expect(plans.get("T2")).toEqual({ "2026-01-05": 240, "2026-01-06": 240 });
  });

  it("(5) keeps a fixed-plan task in place while its P/Q and capacity still constrain others", () => {
    // T1 fixed on 01-05 (Q = 01-05). T2 FS on T1 ⇒ starts 01-06. T3 (no deps,
    // same member) is pushed to 01-07 because 01-05 (fixed) and 01-06 (T2) are full.
    const plans = run({
      members: [member("m1", 480)],
      tasks: [
        task("T1", {
          sortOrder: 1,
          assigneeMemberId: "m1",
          plannedEffortMinutes: 480,
          dailyPlan: { "2026-01-05": 480 },
          fixedDailyPlan: true,
        }),
        task("T2", {
          sortOrder: 2,
          assigneeMemberId: "m1",
          plannedEffortMinutes: 480,
          dependencies: [FS("T1", 0)],
        }),
        task("T3", { sortOrder: 3, assigneeMemberId: "m1", plannedEffortMinutes: 480 }),
      ],
    });
    expect(plans.has("T1")).toBe(false); // fixed plan untouched, not re-emitted
    expect(plans.get("T2")).toEqual({ "2026-01-06": 480 });
    expect(plans.get("T3")).toEqual({ "2026-01-07": 480 });
  });

  it("(6) produces plans whose M = Σ daily and P/Q match the effort EVM module", () => {
    const plans = run({
      members: [member("m1", 480)],
      tasks: [task("T", { assigneeMemberId: "m1", plannedEffortMinutes: 1_440 })],
    });
    const dailyPlan = plans.get("T")!;
    const sumMinutes = Object.values(dailyPlan).reduce((total, minutes) => total + minutes, 0);
    expect(sumMinutes).toBe(1_440); // all of L placed, no rounding

    const metrics = calculateTaskEffort(
      {
        id: "T",
        plannedEffortMinutes: 1_440,
        progressBasisPoints: 0,
        actualEffortMinutes: 0,
        dailyPlan,
      },
      "2026-01-06",
    );
    expect(metrics.plannedEffortHours).toBe(24); // M = Σ daily / 60
    expect(metrics.plannedStart).toBe("2026-01-05"); // P
    expect(metrics.plannedFinish).toBe("2026-01-07"); // Q
  });

  it("(7) places unassigned tasks at the default capacity without leveling them together", () => {
    // No assignee ⇒ default 480/day and no shared ledger, so both fill 01-05.
    expect(DEFAULT_DAILY_CAPACITY_MINUTES).toBe(480);
    const plans = run({
      members: [],
      tasks: [
        task("U1", { sortOrder: 1, plannedEffortMinutes: 960 }),
        task("U2", { sortOrder: 2, plannedEffortMinutes: 480 }),
      ],
    });
    expect(plans.get("U1")).toEqual({ "2026-01-05": 480, "2026-01-06": 480 });
    expect(plans.get("U2")).toEqual({ "2026-01-05": 480 });
  });

  it("(8) delays an FF successor so it finishes on/after the required finish", () => {
    // T1 finishes 01-05. FF lag 1 ⇒ required finish 01-06. Greedy from 01-05 would
    // finish 01-05 (< 01-06), so it re-places from 01-06.
    const plans = run({
      members: [member("m1", 480), member("m2", 480)],
      tasks: [
        task("T1", { sortOrder: 1, assigneeMemberId: "m1", plannedEffortMinutes: 480 }),
        task("T2", {
          sortOrder: 2,
          assigneeMemberId: "m2",
          plannedEffortMinutes: 480,
          dependencies: [{ predecessorId: "T1", type: "FF", lagWorkingDays: 1 }],
        }),
      ],
    });
    expect(plans.get("T2")).toEqual({ "2026-01-06": 480 });
  });

  it("(9) skips non-leaf summary rows, placing and leveling only their leaves", () => {
    // P is a non-leaf summary row that still carries planned effort. It must not
    // be placed (empty plan) nor charge its assignee's ledger — otherwise its 960
    // would consume 01-05/01-06 and push the leaf. With leaf-only placement C fills
    // 01-05 immediately and P stays empty.
    const plans = run({
      members: [member("m1", 480)],
      tasks: [
        task("P", { sortOrder: 1, assigneeMemberId: "m1", plannedEffortMinutes: 960, isLeaf: false }),
        task("C", { sortOrder: 2, assigneeMemberId: "m1", plannedEffortMinutes: 480, isLeaf: true }),
      ],
    });
    expect(plans.get("P")).toEqual({}); // summary row: no own daily plan
    expect(plans.get("C")).toEqual({ "2026-01-05": 480 });
  });

  it("is deterministic across repeated runs", () => {
    const input: EffortScheduleInput = {
      projectStart: "2026-01-05",
      defaultCalendarId: "standard",
      calendars: [STANDARD],
      members: [member("m1", 480)],
      tasks: [
        task("A", { sortOrder: 1, assigneeMemberId: "m1", plannedEffortMinutes: 720 }),
        task("B", { sortOrder: 2, assigneeMemberId: "m1", plannedEffortMinutes: 720, dependencies: [FS("A", 0)] }),
      ],
    };
    const first = new Map(scheduleEffortDailyPlans(input).dailyPlans);
    const second = new Map(scheduleEffortDailyPlans(input).dailyPlans);
    expect(first).toEqual(second);
  });

  it("rejects a dependency cycle with the shared ScheduleCycleError", () => {
    expect(() =>
      scheduleEffortDailyPlans({
        projectStart: "2026-01-05",
        defaultCalendarId: "standard",
        calendars: [STANDARD],
        members: [member("m1", 480)],
        tasks: [
          task("A", { sortOrder: 1, assigneeMemberId: "m1", plannedEffortMinutes: 480, dependencies: [FS("B", 0)] }),
          task("B", { sortOrder: 2, assigneeMemberId: "m1", plannedEffortMinutes: 480, dependencies: [FS("A", 0)] }),
        ],
      }),
    ).toThrowError(new ScheduleCycleError(["A", "B"]));
  });
});
