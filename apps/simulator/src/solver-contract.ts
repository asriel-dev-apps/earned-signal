import { validateForecastResultV1, type ForecastProblemV1, type ForecastResultV1 } from "@earned-signal/application";
import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const ForecastProblemSchema = z.object({
  contractVersion: z.literal("forecast.v1"),
  projectId: identifier,
  sourceRevision: z.string().regex(/^\d+$/),
  completedActualCostMinor: z.number().int().min(0).max(10 ** 15),
  defaultWorkingDates: z.array(date).min(1).max(366),
  tasks: z.array(z.object({
    id: identifier,
    workingDates: z.array(date).min(1).max(366),
    currentStartDate: date,
    dependencies: z.array(z.object({ predecessorTaskId: identifier, type: z.enum(["FS", "SS", "FF", "SF"]), lagWorkingDays: z.number().int().min(0).max(365) })).max(100),
    productiveMinutesPerDay: z.number().int().min(1).max(144_000),
    weightedCostMinorPerHour: z.number().int().min(0).max(100_000_000),
    actualCostMinor: z.number().int().min(0).max(10 ** 15),
    effortEstimate: z.object({ optimisticMinutes: z.number().int().min(1).max(10_000_000), mostLikelyMinutes: z.number().int().min(1).max(10_000_000), pessimisticMinutes: z.number().int().min(1).max(10_000_000) }),
    correlationGroupId: identifier.nullable(),
  })).min(1).max(100),
  correlationGroups: z.array(z.object({ id: identifier, coefficientBasisPoints: z.number().int().min(0).max(9_500) })).max(25),
  seed: z.number().int().min(0).max(0xffff_ffff),
  stopping: z.object({ minIterations: z.number().int().min(1_000).max(50_000), maxIterations: z.number().int().min(1_000).max(50_000), checkEvery: z.number().int().min(100).max(5_000), quantileToleranceBasisPoints: z.number().int().min(0).max(10_000), stableChecks: z.number().int().min(1).max(100) }),
  targetFinishDate: date,
}).strict();

const ForecastSimulatorProblemSchema = ForecastProblemSchema.extend({
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const ForecastResultSchema = z.object({
  contractVersion: z.literal("forecast.v1"), inputHash: z.string().regex(/^[0-9a-f]{64}$/), projectId: identifier, sourceRevision: z.string().regex(/^\d+$/),
  iterations: z.number().int().positive(), converged: z.boolean(), p50FinishDate: date, p80FinishDate: date,
  p50TotalCostMinor: z.number().int().min(0).max(10 ** 15), p80TotalCostMinor: z.number().int().min(0).max(10 ** 15), targetProbabilityBasisPoints: z.number().int().min(0).max(10_000),
  stoppingCheckpoints: z.array(z.object({ iteration: z.number().int().min(1_000).max(50_000), p50FinishDate: date, p80FinishDate: date, p50TotalCostMinor: z.number().int().min(0).max(10 ** 15), p80TotalCostMinor: z.number().int().min(0).max(10 ** 15) })).min(1).max(491),
  quantiles: z.array(z.object({ basisPoints: z.union([z.literal(5000), z.literal(8000)]), finishDate: date, totalCostMinor: z.number().int().min(0).max(10 ** 15) })).length(2),
  finishHistogram: z.array(z.object({ finishDate: date, count: z.number().int().nonnegative() })).min(1).max(366),
  costHistogram: z.array(z.object({ lowerBoundMinor: z.number().int().min(0).max(10 ** 15), upperBoundMinor: z.number().int().min(0).max(10 ** 15), count: z.number().int().nonnegative() })).min(1).max(366),
  metadata: z.object({ algorithmVersion: z.literal("earned-signal-monte-carlo-1"), runtimeVersion: z.string().min(1), seed: z.number().int().min(0).max(0xffff_ffff), randomGenerator: z.literal("mt19937-box-muller-v1"), distributionMethod: z.literal("correlated-normal-cdf-triangular-quantile-v1"), scheduleMethod: z.literal("working-calendar-cpm-v1") }),
}).strict();

const MAX_RESPONSE_BYTES = 1_048_576;
const SIMULATOR_TIMEOUT_MS = 120_000;

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw new Error("Forecast simulator response exceeds 1 MiB");
  if (response.body === null) throw new Error("Forecast simulator returned an empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel("response exceeds limit");
        throw new Error("Forecast simulator response exceeds 1 MiB");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as unknown;
}

export function parseForecastProblem(value: unknown): ForecastProblemV1 {
  return ForecastProblemSchema.parse(value) as ForecastProblemV1;
}

export async function callForecastSimulator(
  problem: ForecastProblemV1,
  inputHash: string,
  fetchSimulator: (request: Request) => Promise<Response>,
): Promise<ForecastResultV1> {
  const response = await fetchSimulator(new Request("http://forecast-simulator/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ForecastSimulatorProblemSchema.parse({ ...problem, inputHash })),
    signal: AbortSignal.timeout(SIMULATOR_TIMEOUT_MS),
  }));
  if (!response.ok) throw new ForecastSimulatorHttpError(response.status);
  const result = ForecastResultSchema.parse(await boundedJson(response)) as ForecastResultV1;
  return validateForecastResultV1(result, problem, inputHash);
}

export class ForecastSimulatorHttpError extends Error {
  constructor(readonly status: number) {
    super(`Forecast simulator returned HTTP ${status}`);
    this.name = "ForecastSimulatorHttpError";
  }
}
