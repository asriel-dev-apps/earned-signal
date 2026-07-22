import { calculateEffortEvm, type EffortInput } from "@vecta/domain";

// Synthetic, generic fixture — no client data. Two leaf tasks of one person-day
// each, one half-done and one complete, so the rollup lands on stable numbers.
const HOME_FIXTURE: EffortInput = {
  statusDate: "2026-01-02",
  tasks: [
    {
      id: "Task 1",
      plannedEffortMinutes: 480,
      progressBasisPoints: 5000,
      actualEffortMinutes: 240,
      dailyPlan: { "2026-01-01": 240, "2026-01-02": 240 },
    },
    {
      id: "Task 2",
      plannedEffortMinutes: 480,
      progressBasisPoints: 10000,
      actualEffortMinutes: 480,
      dailyPlan: { "2026-01-01": 240, "2026-01-02": 240 },
    },
  ],
};

export interface HomeRollupSummary {
  /** BAC — planned effort, person-days. */
  readonly bacDays: number;
  /** EV — earned effort, person-days. */
  readonly evDays: number;
  /** SPI = EV / PV, formatted (or "-" when PV is zero). */
  readonly spi: string;
}

/**
 * Compute a home-screen EVM summary from the synthetic fixture by reusing the
 * pure `calculateEffortEvm` function from `@vecta/domain`. Extracted from the
 * route loader so it can be unit-tested without React Router's virtual imports.
 */
export function computeHomeRollup(
  input: EffortInput = HOME_FIXTURE,
): HomeRollupSummary {
  const { rollup } = calculateEffortEvm(input);
  return {
    bacDays: rollup.bac,
    evDays: rollup.ev,
    spi: typeof rollup.spi === "number" ? rollup.spi.toFixed(2) : rollup.spi,
  };
}
