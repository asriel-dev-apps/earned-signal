import { describe, expect, it } from "vitest";
import { staffingExplanationFallback } from "../src/explainer.js";

describe("staffingExplanationFallback", () => {
  it("uses only verified facts and reports the exact change count", () => {
    expect(staffingExplanationFallback({
      facts: ["Verified finish: 2026-08-14", "Verified overtime minutes: 0"],
      changeDescriptions: ["assignment.replace", "task.update"],
    })).toEqual({
      summary: "The proposal satisfies the verified staffing constraints shown below.",
      details: [
        "Verified finish: 2026-08-14",
        "Verified overtime minutes: 0",
        "The verified plan contains 2 changes.",
      ],
    });
  });
});
