import {
  ProjectCommandValidationError,
  type ProjectCommand,
  type ProjectTask,
  type ScenarioPlanCommand,
} from "@earned-signal/application";
import { MAX_ACTIVITY_DURATION_WORKING_DAYS } from "@earned-signal/domain";
import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const RevisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const MinorUnitSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const ProgressBasisPointsSchema = z.number().int().min(0).max(10_000);
const MeasurementMethodSchema = z.enum(["ZERO_HUNDRED", "PHYSICAL_PERCENT"]);
const DurationSchema = z.number().int().min(1).max(MAX_ACTIVITY_DURATION_WORKING_DAYS);
const CalendarIdSchema = z.string().trim().min(1).max(100);
const SkillIdsSchema = z.array(UuidSchema).max(50);
const DependencySchema = z.object({
  predecessorId: UuidSchema,
  type: z.enum(["FS", "SS", "FF", "SF"]),
  lagWorkingDays: z.number().int().min(0).max(MAX_ACTIVITY_DURATION_WORKING_DAYS),
});
const ConstraintSchema = z.object({
  type: z.enum([
    "START_NO_EARLIER_THAN",
    "FINISH_NO_LATER_THAN",
    "MUST_START_ON",
    "MUST_FINISH_ON",
  ]),
  date: z.iso.date(),
});

const TaskChangesFieldsSchema = z.object({
    wbs: z.string().trim().min(1).optional(),
    wbsParentId: UuidSchema.nullable().optional(),
    name: z.string().trim().min(1).optional(),
    owner: z.string().optional(),
    durationWorkingDays: DurationSchema.optional(),
    measurementMethod: MeasurementMethodSchema.optional(),
    calendarId: CalendarIdSchema.optional(),
    dependencies: z.array(DependencySchema).max(100).optional(),
    constraint: ConstraintSchema.nullable().optional(),
    requiredSkillIds: SkillIdsSchema.optional(),
    budgetMinor: MinorUnitSchema.optional(),
    progressBasisPoints: ProgressBasisPointsSchema.optional(),
    actualCostMinor: MinorUnitSchema.optional(),
    actualMinutes: z.number().int().nonnegative().optional(),
  }).strict();

export const TaskChangesSchema = TaskChangesFieldsSchema
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

const ScenarioTaskChangesSchema = TaskChangesFieldsSchema.omit({
  progressBasisPoints: true,
  actualCostMinor: true,
  actualMinutes: true,
}).refine((changes) => Object.keys(changes).length > 0, "At least one plan change is required");

export const TaskSchema = z.object({
  id: UuidSchema,
  wbs: z.string().trim().min(1),
  wbsParentId: UuidSchema.nullable(),
  name: z.string().trim().min(1),
  owner: z.string(),
  durationWorkingDays: DurationSchema,
  measurementMethod: MeasurementMethodSchema,
  calendarId: CalendarIdSchema,
  dependencies: z.array(DependencySchema).max(100),
  constraint: ConstraintSchema.nullable(),
  requiredSkillIds: SkillIdsSchema,
  budgetMinor: MinorUnitSchema,
  progressBasisPoints: ProgressBasisPointsSchema,
  actualCostMinor: MinorUnitSchema,
  actualMinutes: z.number().int().nonnegative(),
}).strict();

export const ResourceSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(200),
  calendarId: CalendarIdSchema,
  dailyCapacityMinutes: z.number().int().min(1).max(1_440),
  costRateMinorPerHour: MinorUnitSchema,
  skillIds: SkillIdsSchema,
}).strict();

export const ResourceChangesSchema = ResourceSchema.omit({ id: true })
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

export const AssignmentSchema = z.object({
  resourceId: UuidSchema,
  unitsPercent: z.number().int().min(1).max(100),
}).strict();

export const ScenarioPlanCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.update"), taskId: UuidSchema, changes: ScenarioTaskChangesSchema }).strict(),
  z.object({ type: z.literal("task.add"), task: TaskSchema.refine(
    (task) => task.progressBasisPoints === 0 && task.actualCostMinor === "0" && task.actualMinutes === 0,
    "Scenario tasks cannot contain progress or actuals",
  ) }).strict(),
  z.object({ type: z.literal("task.delete"), taskId: UuidSchema }).strict(),
  z.object({ type: z.literal("resource.add"), resource: ResourceSchema }).strict(),
  z.object({ type: z.literal("resource.update"), resourceId: UuidSchema, changes: ResourceChangesSchema }).strict(),
  z.object({ type: z.literal("resource.delete"), resourceId: UuidSchema }).strict(),
  z.object({ type: z.literal("assignment.replace"), taskId: UuidSchema, assignments: z.array(AssignmentSchema).max(100) }).strict(),
]);

export const ApiCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("baseline.publish"), label: z.string().trim().min(1).max(200) }),
  z.object({
    type: z.literal("scenario.publish"),
    scenarioId: UuidSchema,
    scenarioRevision: RevisionSchema,
    sourceProjectRevision: RevisionSchema,
    changes: z.array(ScenarioPlanCommandSchema).min(1).max(500),
  }),
  z.object({
    type: z.literal("task.update"),
    taskId: UuidSchema,
    changes: TaskChangesSchema,
  }),
  z.object({ type: z.literal("task.add"), task: TaskSchema }),
  z.object({ type: z.literal("task.delete"), taskId: UuidSchema }),
  z.object({ type: z.literal("resource.add"), resource: ResourceSchema }),
  z.object({
    type: z.literal("resource.update"),
    resourceId: UuidSchema,
    changes: ResourceChangesSchema,
  }),
  z.object({ type: z.literal("resource.delete"), resourceId: UuidSchema }),
  z.object({
    type: z.literal("assignment.replace"),
    taskId: UuidSchema,
    assignments: z.array(AssignmentSchema).max(100),
  }),
]);

function asSafeMinorUnits(value: string, field: string): number {
  const parsed = BigInt(value);
  const result = Number(parsed);
  if (!Number.isSafeInteger(result)) {
    throw new ProjectCommandValidationError(`${field} exceeds the supported API range`);
  }
  return result;
}

function toTask(task: z.infer<typeof TaskSchema>): ProjectTask {
  return {
    id: task.id,
    wbs: task.wbs,
    wbsParentId: task.wbsParentId,
    name: task.name,
    owner: task.owner,
    durationWorkingDays: task.durationWorkingDays,
    measurementMethod: task.measurementMethod,
    calendarId: task.calendarId,
    dependencies: task.dependencies,
    constraint: task.constraint,
    requiredSkillIds: task.requiredSkillIds,
    budget: asSafeMinorUnits(task.budgetMinor, "budgetMinor"),
    progressPercent: task.progressBasisPoints / 100,
    actualCost: asSafeMinorUnits(task.actualCostMinor, "actualCostMinor"),
    actualMinutes: task.actualMinutes,
  };
}

export function toCommand(command: z.infer<typeof ApiCommandSchema>): ProjectCommand {
  if (command.type === "baseline.publish") return command;
  if (command.type === "scenario.publish") {
    return {
      ...command,
      changes: command.changes.map((change) => toCommand(change) as ScenarioPlanCommand),
    };
  }
  if (command.type === "task.add") {
    return { type: command.type, task: toTask(command.task) };
  }
  if (command.type === "task.delete") {
    return command;
  }
  if (command.type === "resource.add") {
    return {
      type: command.type,
      resource: {
        ...command.resource,
        costRateMinorPerHour: asSafeMinorUnits(
          command.resource.costRateMinorPerHour,
          "costRateMinorPerHour",
        ),
      },
    };
  }
  if (command.type === "resource.update") {
    return {
      type: command.type,
      resourceId: command.resourceId,
      changes: {
        ...(command.changes.name === undefined ? {} : { name: command.changes.name }),
        ...(command.changes.calendarId === undefined
          ? {}
          : { calendarId: command.changes.calendarId }),
        ...(command.changes.dailyCapacityMinutes === undefined
          ? {}
          : { dailyCapacityMinutes: command.changes.dailyCapacityMinutes }),
        ...(command.changes.skillIds === undefined
          ? {}
          : { skillIds: command.changes.skillIds }),
        ...(command.changes.costRateMinorPerHour === undefined
          ? {}
          : {
              costRateMinorPerHour: asSafeMinorUnits(
                command.changes.costRateMinorPerHour,
                "costRateMinorPerHour",
              ),
            }),
      },
    };
  }
  if (command.type === "resource.delete" || command.type === "assignment.replace") {
    return command;
  }

  const changes = {
    ...(command.changes.wbs === undefined ? {} : { wbs: command.changes.wbs }),
    ...(command.changes.wbsParentId === undefined
      ? {}
      : { wbsParentId: command.changes.wbsParentId }),
    ...(command.changes.name === undefined ? {} : { name: command.changes.name }),
    ...(command.changes.owner === undefined ? {} : { owner: command.changes.owner }),
    ...(command.changes.durationWorkingDays === undefined
      ? {}
      : { durationWorkingDays: command.changes.durationWorkingDays }),
    ...(command.changes.measurementMethod === undefined
      ? {}
      : { measurementMethod: command.changes.measurementMethod }),
    ...(command.changes.calendarId === undefined
      ? {}
      : { calendarId: command.changes.calendarId }),
    ...(command.changes.dependencies === undefined
      ? {}
      : { dependencies: command.changes.dependencies }),
    ...(command.changes.constraint === undefined
      ? {}
      : { constraint: command.changes.constraint }),
    ...(command.changes.requiredSkillIds === undefined
      ? {}
      : { requiredSkillIds: command.changes.requiredSkillIds }),
    ...(command.changes.budgetMinor === undefined
      ? {}
      : { budget: asSafeMinorUnits(command.changes.budgetMinor, "budgetMinor") }),
    ...(command.changes.progressBasisPoints === undefined
      ? {}
      : { progressPercent: command.changes.progressBasisPoints / 100 }),
    ...(command.changes.actualCostMinor === undefined
      ? {}
      : {
          actualCost: asSafeMinorUnits(
            command.changes.actualCostMinor,
            "actualCostMinor",
          ),
        }),
    ...(command.changes.actualMinutes === undefined
      ? {}
      : { actualMinutes: command.changes.actualMinutes }),
  } satisfies Partial<Omit<ProjectTask, "id">>;
  return { type: command.type, taskId: command.taskId, changes };
}

function fromTask(task: ProjectTask): z.infer<typeof TaskSchema> {
  return {
    ...task,
    dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
    constraint: task.constraint === null ? null : { ...task.constraint },
    requiredSkillIds: [...task.requiredSkillIds],
    budgetMinor: String(task.budget),
    progressBasisPoints: Math.round(task.progressPercent * 100),
    actualCostMinor: String(task.actualCost),
  };
}

export function fromCommand(command: ProjectCommand): z.infer<typeof ApiCommandSchema> {
  if (command.type === "baseline.publish") return command;
  if (command.type === "scenario.publish") {
    return {
      ...command,
      changes: command.changes.map((change) => fromCommand(change) as z.infer<typeof ScenarioPlanCommandSchema>),
    };
  }
  if (command.type === "task.add") return { type: command.type, task: fromTask(command.task) };
  if (command.type === "task.delete" || command.type === "resource.delete") return command;
  if (command.type === "assignment.replace") return { ...command, assignments: command.assignments.map((assignment) => ({ ...assignment })) };
  if (command.type === "resource.add") return { type: command.type, resource: { ...command.resource, skillIds: [...command.resource.skillIds], costRateMinorPerHour: String(command.resource.costRateMinorPerHour) } };
  if (command.type === "resource.update") {
    const { costRateMinorPerHour, skillIds, ...changes } = command.changes;
    return {
      type: command.type,
      resourceId: command.resourceId,
      changes: {
        ...changes,
        ...(skillIds === undefined ? {} : { skillIds: [...skillIds] }),
        ...(costRateMinorPerHour === undefined ? {} : { costRateMinorPerHour: String(costRateMinorPerHour) }),
      },
    };
  }
  const { budget, progressPercent, actualCost, dependencies, constraint, requiredSkillIds, ...changes } = command.changes;
  return {
    type: command.type,
    taskId: command.taskId,
    changes: {
      ...changes,
      ...(dependencies === undefined ? {} : { dependencies: dependencies.map((dependency) => ({ ...dependency })) }),
      ...(constraint === undefined ? {} : { constraint: constraint === null ? null : { ...constraint } }),
      ...(requiredSkillIds === undefined ? {} : { requiredSkillIds: [...requiredSkillIds] }),
      ...(budget === undefined ? {} : { budgetMinor: String(budget) }),
      ...(progressPercent === undefined ? {} : { progressBasisPoints: Math.round(progressPercent * 100) }),
      ...(actualCost === undefined ? {} : { actualCostMinor: String(actualCost) }),
    },
  };
}
