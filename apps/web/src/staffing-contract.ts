import type {
  ProjectResource,
  StaffingProposalRequest,
} from "@earned-signal/application";
import { validateStaffingProposalRequest } from "@earned-signal/application";
import type { StaffingProposal, StaffingProposalJson } from "@earned-signal/persistence";
import { z } from "@hono/zod-openapi";
import { RevisionSchema, UuidSchema } from "./project-command-contract.js";

const SafeNonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const StaffingCandidateResourceSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(200),
  calendarId: z.string().trim().min(1).max(100),
  dailyCapacityMinutes: z.number().int().min(1).max(1_440),
  costRateMinorPerHour: SafeNonNegativeIntegerSchema,
  skillIds: z.array(UuidSchema).max(100),
}).strict();

export const ConfirmedRemainingEffortSchema = z.object({
  taskId: UuidSchema,
  remainingEffortMinutes: SafeNonNegativeIntegerSchema,
  maxParallelResources: z.number().int().min(1).max(100),
  provenance: z.literal("HUMAN_CONFIRMED"),
}).strict();

export const StaffingConstraintsSchema = z.object({
  version: z.literal("staffing-constraints-v1"),
  deadline: z.iso.date().nullable(),
  maxPlannedLaborCostMinor: SafeNonNegativeIntegerSchema.nullable(),
  maxOvertimeMinutes: SafeNonNegativeIntegerSchema.nullable(),
  maxAssignmentChanges: SafeNonNegativeIntegerSchema.nullable(),
  maxScheduleChanges: SafeNonNegativeIntegerSchema.nullable(),
  maxCandidateResources: z.number().int().min(0).max(100),
  requireSkillCoverage: z.literal(true),
}).strict();

export const StaffingObjectiveSchema = z.object({
  version: z.literal("staffing-objective-v1"),
  priorities: z.array(z.enum([
    "MINIMIZE_FINISH",
    "MINIMIZE_COST",
    "MINIMIZE_OVERTIME",
    "MINIMIZE_CHANGE",
  ])).length(4).refine(
    (priorities) => priorities.join(",") === "MINIMIZE_FINISH,MINIMIZE_OVERTIME,MINIMIZE_COST,MINIMIZE_CHANGE",
    "Staffing objective priorities must use the fixed verified order",
  ),
}).strict();

export const StaffingProposalCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  expectedRevision: RevisionSchema,
  remainingEffort: z.array(ConfirmedRemainingEffortSchema).max(1_000),
  candidateResources: z.array(StaffingCandidateResourceSchema).max(100).default([]),
  constraints: StaffingConstraintsSchema,
  objective: StaffingObjectiveSchema,
}).strict().openapi("StaffingProposalCreateRequest");

export const StaffingProposalResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  status: z.enum(["REQUESTED", "RUNNING", "READY", "INFEASIBLE", "UNKNOWN", "FAILED"]),
  baseProjectRevision: RevisionSchema,
  linkedScenarioId: UuidSchema.nullable(),
  latestRun: z.object({
    id: UuidSchema,
    status: z.enum(["READY", "INFEASIBLE", "UNKNOWN", "FAILED"]),
    algorithmVersion: z.string(),
    output: z.unknown(),
    createdAt: z.string().datetime(),
  }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
}).openapi("StaffingProposalResponse");

export function staffingProposalInput(
  body: z.infer<typeof StaffingProposalCreateSchema>,
  current: StaffingProposalRequest["current"],
): StaffingProposalJson {
  const request: StaffingProposalRequest = {
    currentRevision: body.expectedRevision,
    current,
    remainingEffort: body.remainingEffort,
    candidateResources: body.candidateResources as readonly ProjectResource[],
    constraints: body.constraints,
    objective: body.objective,
  };
  validateStaffingProposalRequest(request);
  return request as unknown as StaffingProposalJson;
}

export function staffingProposalResponse(proposal: StaffingProposal) {
  const isoTimestamp = (value: string) => new Date(value).toISOString();
  return StaffingProposalResponseSchema.parse({
    id: proposal.id,
    name: proposal.name,
    status: proposal.status,
    baseProjectRevision: proposal.baseProjectRevision.toString(),
    linkedScenarioId: proposal.linkedScenarioId,
    latestRun: proposal.latestRun === null ? null : {
      id: proposal.latestRun.id,
      status: proposal.latestRun.status,
      algorithmVersion: proposal.latestRun.algorithmVersion,
      output: proposal.latestRun.output,
      createdAt: isoTimestamp(proposal.latestRun.createdAt),
    },
    createdAt: isoTimestamp(proposal.createdAt),
    updatedAt: isoTimestamp(proposal.updatedAt),
    startedAt: proposal.startedAt === null ? null : isoTimestamp(proposal.startedAt),
    completedAt: proposal.completedAt === null ? null : isoTimestamp(proposal.completedAt),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Staffing Proposal hash input must be JSON-safe");
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
    ([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`,
  ).join(",")}}`;
}

export async function staffingProposalHash(name: string, input: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson({ name: name.trim(), input })),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
