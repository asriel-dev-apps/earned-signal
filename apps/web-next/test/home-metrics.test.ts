import { describe, expect, it } from "vitest";
import { computeHomeRollup } from "../app/lib/home-metrics";

describe("computeHomeRollup", () => {
  it("reuses the domain EVM calc over the synthetic fixture", () => {
    const summary = computeHomeRollup();
    // Two leaf tasks of one person-day each: BAC = 2, EV = 0.5 + 1.0 = 1.5,
    // PV = 2, so SPI = 1.5 / 2 = 0.75.
    expect(summary.bacDays).toBe(2);
    expect(summary.evDays).toBe(1.5);
    expect(summary.spi).toBe("0.75");
  });
});
