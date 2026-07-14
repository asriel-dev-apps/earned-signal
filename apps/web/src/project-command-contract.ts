import {
  ProjectCommandValidationError,
  type ProjectCommand,
  type ProjectTask,
} from "@earned-signal/application";
import { MAX_ACTIVITY_DURATION_WORKING_DAYS } from "@earned-signal/domain";
import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const RevisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const MinorUnitSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const ProgressBasisPointsSchema = z.number().int().min(0).max(10_000);
const MeasurementMethodSchema = z.enum(["ZERO_HUNDRED", "PHYSICAL_PERCENT"]);
const DurationSchema = z.number().int().min(1).max(MAX_ACTIVITY_DURATION_WORKING_DAYS);

export const TaskChangesSchema = z
  .object({
    wbs: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    owner: z.string().optional(),
    durationWorkingDays: DurationSchema.optional(),
    measurementMethod: MeasurementMethodSchema.optional(),
    predecessorId: UuidSchema.nullable().optional(),
    budgetMinor: MinorUnitSchema.optional(),
    progressBasisPoints: ProgressBasisPointsSchema.optional(),
    actualCostMinor: MinorUnitSchema.optional(),
    actualMinutes: z.number().int().nonnegative().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

export const TaskSchema = z.object({
  id: UuidSchema,
  wbs: z.string().trim().min(1),
  name: z.string().trim().min(1),
  owner: z.string(),
  durationWorkingDays: DurationSchema,
  measurementMethod: MeasurementMethodSchema,
  predecessorId: UuidSchema.nullable(),
  budgetMinor: MinorUnitSchema,
  progressBasisPoints: ProgressBasisPointsSchema,
  actualCostMinor: MinorUnitSchema,
  actualMinutes: z.number().int().nonnegative(),
});

export const ApiCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.update"),
    taskId: UuidSchema,
    changes: TaskChangesSchema,
  }),
  z.object({ type: z.literal("task.add"), task: TaskSchema }),
  z.object({ type: z.literal("task.delete"), taskId: UuidSchema }),
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
    name: task.name,
    owner: task.owner,
    durationWorkingDays: task.durationWorkingDays,
    measurementMethod: task.measurementMethod,
    predecessorId: task.predecessorId,
    budget: asSafeMinorUnits(task.budgetMinor, "budgetMinor"),
    progressPercent: task.progressBasisPoints / 100,
    actualCost: asSafeMinorUnits(task.actualCostMinor, "actualCostMinor"),
    actualMinutes: task.actualMinutes,
  };
}

export function toCommand(command: z.infer<typeof ApiCommandSchema>): ProjectCommand {
  if (command.type === "task.add") {
    return { type: command.type, task: toTask(command.task) };
  }
  if (command.type === "task.delete") {
    return command;
  }

  const changes = {
    ...(command.changes.wbs === undefined ? {} : { wbs: command.changes.wbs }),
    ...(command.changes.name === undefined ? {} : { name: command.changes.name }),
    ...(command.changes.owner === undefined ? {} : { owner: command.changes.owner }),
    ...(command.changes.durationWorkingDays === undefined
      ? {}
      : { durationWorkingDays: command.changes.durationWorkingDays }),
    ...(command.changes.measurementMethod === undefined
      ? {}
      : { measurementMethod: command.changes.measurementMethod }),
    ...(command.changes.predecessorId === undefined
      ? {}
      : { predecessorId: command.changes.predecessorId }),
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
