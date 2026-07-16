import { MAX_ACTIVITY_DURATION_WORKING_DAYS } from "@earned-signal/domain";
import { z } from "@hono/zod-openapi";
import { RevisionSchema, UuidSchema } from "./project-command-contract.js";

const DateSchema = z.iso.date();
const DependencySchema = z.object({
  predecessorId: UuidSchema,
  type: z.enum(["FS", "SS", "FF", "SF"]),
  lagWorkingDays: z.number().int().min(0).max(MAX_ACTIVITY_DURATION_WORKING_DAYS),
}).strict();
const ConstraintSchema = z.object({
  type: z.enum([
    "START_NO_EARLIER_THAN",
    "FINISH_NO_LATER_THAN",
    "MUST_START_ON",
    "MUST_FINISH_ON",
  ]),
  date: DateSchema,
}).strict();
const TaskSchema = z.object({
  id: UuidSchema,
  wbs: z.string(),
  wbsParentId: UuidSchema.nullable(),
  name: z.string(),
  owner: z.string(),
  durationWorkingDays: z.number().int().min(1).max(MAX_ACTIVITY_DURATION_WORKING_DAYS),
  measurementMethod: z.enum(["ZERO_HUNDRED", "PHYSICAL_PERCENT"]),
  calendarId: z.string(),
  dependencies: z.array(DependencySchema),
  constraint: ConstraintSchema.nullable(),
  requiredSkillIds: z.array(UuidSchema),
  budget: z.number().int().nonnegative(),
  progressPercent: z.number().min(0).max(100),
  actualCost: z.number().int().nonnegative(),
  actualMinutes: z.number().int().nonnegative(),
}).strict();
const ResourceSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  calendarId: z.string(),
  dailyCapacityMinutes: z.number().int().positive(),
  costRateMinorPerHour: z.number().int().nonnegative(),
  skillIds: z.array(UuidSchema),
}).strict();
const ProjectStateSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  projectStart: DateSchema,
  statusDate: DateSchema,
  currency: z.literal("JPY"),
  defaultCalendarId: z.string(),
  calendars: z.array(z.object({
    id: z.string(),
    name: z.string(),
    workingWeekdays: z.array(z.number().int()),
    nonWorkingDates: z.array(DateSchema),
  }).strict()),
  wbsGroups: z.array(z.object({
    id: UuidSchema,
    parentId: UuidSchema.nullable(),
    code: z.string(),
    name: z.string(),
  }).strict()),
  skills: z.array(z.object({ id: UuidSchema, name: z.string() }).strict()),
  resources: z.array(ResourceSchema),
  assignments: z.array(z.object({
    taskId: UuidSchema,
    resourceId: UuidSchema,
    unitsPercent: z.number().int().min(1).max(100),
  }).strict()),
  tasks: z.array(TaskSchema),
}).strict();

const TaskChangesSchema = TaskSchema.omit({
  id: true,
  progressPercent: true,
  actualCost: true,
  actualMinutes: true,
}).partial().strict().refine(
  (changes) => Object.keys(changes).length > 0,
  "At least one plan change is required",
);
const ResourceChangesSchema = ResourceSchema.omit({ id: true }).partial().strict().refine(
  (changes) => Object.keys(changes).length > 0,
  "At least one change is required",
);
export const ScenarioPlanCommandResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.update"), taskId: UuidSchema, changes: TaskChangesSchema }).strict(),
  z.object({ type: z.literal("task.add"), task: TaskSchema.refine(
    (task) => task.progressPercent === 0 && task.actualCost === 0 && task.actualMinutes === 0,
    "Scenario tasks cannot contain progress or actuals",
  ) }).strict(),
  z.object({ type: z.literal("task.delete"), taskId: UuidSchema }).strict(),
  z.object({ type: z.literal("resource.add"), resource: ResourceSchema }).strict(),
  z.object({ type: z.literal("resource.update"), resourceId: UuidSchema, changes: ResourceChangesSchema }).strict(),
  z.object({ type: z.literal("resource.delete"), resourceId: UuidSchema }).strict(),
  z.object({
    type: z.literal("assignment.replace"),
    taskId: UuidSchema,
    assignments: z.array(z.object({
      resourceId: UuidSchema,
      unitsPercent: z.number().int().min(1).max(100),
    }).strict()),
  }).strict(),
]);

const CapacitySchema = z.object({
  resources: z.array(z.object({
    resourceId: UuidSchema,
    totalCapacityMinutes: z.number().int().nonnegative(),
    totalDemandMinutes: z.number().int().nonnegative(),
    overallocatedMinutes: z.number().int().nonnegative(),
    utilizationPercent: z.number().nonnegative(),
    plannedLaborCostMinor: z.number().int().nonnegative(),
    skillGapActivityIds: z.array(UuidSchema),
    days: z.array(z.object({
      date: DateSchema,
      capacityMinutes: z.number().int().nonnegative(),
      demandMinutes: z.number().int().nonnegative(),
      overallocatedMinutes: z.number().int().nonnegative(),
    }).strict()),
  }).strict()),
  overallocatedResourceIds: z.array(UuidSchema),
  skillGapActivityIds: z.array(UuidSchema),
}).strict();
const TaskForecastSchema = z.object({
  taskId: UuidSchema,
  start: DateSchema,
  finish: DateSchema,
}).strict();

export const ScenarioResultSchema = z.object({
  plan: ProjectStateSchema,
  comparison: z.object({
    currentFinish: DateSchema,
    currentEac: z.number().nonnegative(),
    currentPlannedLaborCost: z.number().nonnegative(),
    currentCapacity: CapacitySchema,
    tasks: z.array(TaskForecastSchema),
  }).strict(),
  factors: z.object({
    schedule: z.number().positive(),
    cost: z.number().positive(),
    scheduleFallback: z.boolean(),
    costFallback: z.boolean(),
  }).strict(),
  forecast: z.object({
    finish: DateSchema,
    eac: z.number().nonnegative(),
    plannedLaborCost: z.number().nonnegative(),
    capacity: CapacitySchema,
    tasks: z.array(TaskForecastSchema),
  }).strict(),
  changes: z.array(ScenarioPlanCommandResponseSchema),
}).strict().openapi("ScenarioResult");

export const ScenarioResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  status: z.enum(["DRAFT", "PUBLISHED", "DISCARDED"]),
  baseProjectRevision: RevisionSchema,
  revision: RevisionSchema,
  changes: z.array(ScenarioPlanCommandResponseSchema),
  latestRun: z.object({
    id: UuidSchema,
    sourceProjectRevision: RevisionSchema,
    sourceScenarioRevision: RevisionSchema,
    algorithmVersion: z.string(),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    output: ScenarioResultSchema,
    createdAt: z.string().min(1),
  }).strict().nullable(),
  updatedAt: z.string().min(1),
  publishedAt: z.string().min(1).nullable(),
  discardedAt: z.string().min(1).nullable(),
}).strict().openapi("ScenarioResponse");
