import {
  staffingExplanationFallback,
  type StaffingExplainer,
  type StaffingExplanation,
} from "@earned-signal/application";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function parseExplanation(value: unknown): StaffingExplanation | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly summary?: unknown; readonly details?: unknown };
  if (
    typeof candidate.summary !== "string" ||
    candidate.summary.trim().length === 0 ||
    candidate.summary.length > 600 ||
    !Array.isArray(candidate.details) ||
    candidate.details.length > 8 ||
    candidate.details.some((detail) =>
      typeof detail !== "string" || detail.trim().length === 0 || detail.length > 500)
  ) {
    return null;
  }
  return {
    summary: candidate.summary.trim(),
    details: candidate.details.map((detail) => (detail as string).trim()),
  };
}

export function createStaffingExplainer(ai: Env["AI"]): StaffingExplainer {
  return {
    async explain(input) {
      const fallback = staffingExplanationFallback(input);
      try {
        const result = await ai.run(MODEL, {
          messages: [
            {
              role: "system",
              content: "Explain only the supplied verified staffing facts and exact changes. Copy every numeric, date, and entity identifier literal exactly; do not invent, revise, or recommend plan values.",
            },
            {
              role: "user",
              content: JSON.stringify({ facts: input.facts, changes: input.changeDescriptions }),
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                summary: { type: "string" },
                details: { type: "array", maxItems: 8, items: { type: "string" } },
              },
              required: ["summary", "details"],
            },
          },
          max_tokens: 500,
        });
        if (typeof result !== "object" || result === null || !("response" in result)) return fallback;
        return parseExplanation(result.response) ?? fallback;
      } catch {
        return fallback;
      }
    },
  };
}

export { staffingExplanationFallback };
