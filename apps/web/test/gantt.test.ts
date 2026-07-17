import { describe, expect, it } from "vitest";
import { buildGanttScale, ganttPosition } from "../src/gantt";

describe("WBS Gantt scale", () => {
  it("covers every activity and exposes evenly distributed date ticks", () => {
    const scale = buildGanttScale([
      { start: "2026-07-01", finish: "2026-07-10" },
      { start: "2026-07-08", finish: "2026-07-24" },
    ]);

    expect(scale.start).toBe("2026-07-01");
    expect(scale.finish).toBe("2026-07-24");
    expect(scale.dayCount).toBe(24);
    expect(scale.ticks[0]).toBe("2026-07-01");
    expect(scale.ticks.at(-1)).toBe("2026-07-24");
  });

  it("places inclusive activity bars on the shared calendar axis", () => {
    const scale = buildGanttScale([{ start: "2026-07-01", finish: "2026-07-10" }]);

    expect(ganttPosition("2026-07-01", "2026-07-05", scale)).toEqual({ left: 0, width: 50 });
    expect(ganttPosition("2026-07-06", "2026-07-10", scale)).toEqual({ left: 50, width: 50 });
  });
});
