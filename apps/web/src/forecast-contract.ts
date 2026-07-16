import { z } from "@hono/zod-openapi";
import { RevisionSchema, UuidSchema } from "./project-command-contract.js";

const ForecastEstimateSchema = z.object({
  taskId: UuidSchema,
  optimisticMinutes: z.number().int().min(1).max(10_000_000),
  mostLikelyMinutes: z.number().int().min(1).max(10_000_000),
  pessimisticMinutes: z.number().int().min(1).max(10_000_000),
  provenance: z.literal("HUMAN_CONFIRMED"),
}).superRefine((estimate, context) => {
  if (estimate.optimisticMinutes > estimate.mostLikelyMinutes || estimate.mostLikelyMinutes > estimate.pessimisticMinutes) {
    context.addIssue({ code: "custom", message: "Estimate must satisfy optimistic <= most likely <= pessimistic" });
  }
});

const ForecastCorrelationGroupSchema = z.object({
  id: z.string().trim().min(1).max(100),
  taskIds: z.array(UuidSchema).min(2).max(100),
  coefficientBasisPoints: z.number().int().min(0).max(9_500),
});

export const ForecastRunCreateSchema = z.object({
  expectedRevision: RevisionSchema,
  expectedScenarioRevision: RevisionSchema,
  estimates: z.array(ForecastEstimateSchema).min(1).max(100),
  correlationGroups: z.array(ForecastCorrelationGroupSchema).max(25).default([]),
  seed: z.number().int().min(0).max(0xffff_ffff),
  stopping: z.object({
    minIterations: z.number().int().min(1_000).max(50_000),
    maxIterations: z.number().int().min(1_000).max(50_000),
    checkEvery: z.number().int().min(100).max(5_000),
    quantileToleranceBasisPoints: z.number().int().min(0).max(10_000),
    stableChecks: z.number().int().min(1).max(100),
  }),
  targetDate: z.iso.date(),
}).openapi("ForecastRunCreate");

export type ForecastRunCreateInput = z.infer<typeof ForecastRunCreateSchema>;

export const ForecastResultSchema = z.object({
  contractVersion: z.literal("forecast.v1"),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  projectId: UuidSchema,
  sourceRevision: RevisionSchema,
  iterations: z.number().int().positive(),
  converged: z.boolean(),
  p50FinishDate: z.iso.date(),
  p80FinishDate: z.iso.date(),
  p50TotalCostMinor: z.number().int().min(0).max(10 ** 15),
  p80TotalCostMinor: z.number().int().min(0).max(10 ** 15),
  targetProbabilityBasisPoints: z.number().int().min(0).max(10_000),
  stoppingCheckpoints: z.array(z.object({ iteration: z.number().int().min(1_000).max(50_000), p50FinishDate: z.iso.date(), p80FinishDate: z.iso.date(), p50TotalCostMinor: z.number().int().min(0).max(10 ** 15), p80TotalCostMinor: z.number().int().min(0).max(10 ** 15) })).min(1).max(491),
  quantiles: z.array(z.object({ basisPoints: z.union([z.literal(5000), z.literal(8000)]), finishDate: z.iso.date(), totalCostMinor: z.number().int().min(0).max(10 ** 15) })).length(2),
  finishHistogram: z.array(z.object({ finishDate: z.iso.date(), count: z.number().int().nonnegative() })).min(1).max(366),
  costHistogram: z.array(z.object({ lowerBoundMinor: z.number().int().min(0).max(10 ** 15), upperBoundMinor: z.number().int().min(0).max(10 ** 15), count: z.number().int().nonnegative() })).min(1).max(366),
  metadata: z.object({
    algorithmVersion: z.literal("earned-signal-monte-carlo-1"),
    runtimeVersion: z.string().trim().min(1),
    seed: z.number().int().min(0).max(0xffff_ffff),
    randomGenerator: z.literal("mt19937-box-muller-v1"),
    distributionMethod: z.literal("correlated-normal-cdf-triangular-quantile-v1"),
    scheduleMethod: z.literal("working-calendar-cpm-v1"),
  }),
}).openapi("ForecastResult");

export type ForecastResultDocument = z.infer<typeof ForecastResultSchema>;

export const ForecastRunDocumentSchema = z.object({
  id: UuidSchema,
  status: z.enum(["REQUESTED", "RUNNING", "READY", "FAILED"]),
  sourceProjectRevision: RevisionSchema,
  sourceScenarioRevision: RevisionSchema,
  targetDate: z.iso.date(),
  result: ForecastResultSchema.nullable(),
  failure: z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1) }).nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
}).superRefine((run, context) => {
  const ready = run.status === "READY";
  const failed = run.status === "FAILED";
  if (ready !== (run.result !== null)) context.addIssue({ code: "custom", message: "READY Forecast Run must contain exactly one result" });
  if (failed !== (run.failure !== null)) context.addIssue({ code: "custom", message: "FAILED Forecast Run must contain exactly one failure" });
  if ((ready || failed) !== (run.completedAt !== null)) context.addIssue({ code: "custom", message: "Terminal Forecast Run completion timestamp is inconsistent" });
  if (run.status === "REQUESTED" && run.startedAt !== null) context.addIssue({ code: "custom", message: "REQUESTED Forecast Run must not have a start timestamp" });
  if (run.status !== "REQUESTED" && run.startedAt === null) context.addIssue({ code: "custom", message: "Started Forecast Run requires a start timestamp" });
});
