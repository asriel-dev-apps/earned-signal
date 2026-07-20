import type { ProjectCommand, ProjectTask } from "@vecta/application";
import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const RevisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

const IsoDateSchema = z.iso.date();
const MetaTextSchema = z.string().max(2_000);
const EffortMinutesSchema = z.number().int().min(0).max(100_000_000);
const ProgressBasisPointsSchema = z.number().int().min(0).max(10_000);
const ProrationWeightSchema = z.number().int().min(0).max(10_000).nullable();
const SortOrderSchema = z.number().int().min(0);
const CalendarIdSchema = z.string().trim().min(1).max(100);
const TemplateIdSchema = z.string().trim().min(1).max(100);

const DependencySchema = z.object({
  predecessorId: UuidSchema,
  type: z.enum(["FS", "SS", "FF", "SF"]),
  lagWorkingDays: z.number().int().min(0).max(3_650),
});

const DailyPlanSchema = z.record(IsoDateSchema, z.number().nonnegative());

const TaskFieldsSchema = z.object({
  parentId: UuidSchema.nullable(),
  sortOrder: SortOrderSchema,
  name: z.string().trim().min(1).max(2_000),
  process: MetaTextSchema,
  product: MetaTextSchema,
  reviewRef: MetaTextSchema,
  changeRef: MetaTextSchema,
  note: MetaTextSchema,
  contract: MetaTextSchema,
  assigneeMemberId: UuidSchema.nullable(),
  plannedEffortMinutes: EffortMinutesSchema,
  progressBasisPoints: ProgressBasisPointsSchema,
  actualEffortMinutes: EffortMinutesSchema,
  prorationWeightBp: ProrationWeightSchema,
  dailyPlan: DailyPlanSchema,
  dailyPlanLocked: z.boolean(),
  actualStart: IsoDateSchema.nullable(),
  actualFinish: IsoDateSchema.nullable(),
  dependencies: z.array(DependencySchema).max(200),
});

export const TaskSchema = TaskFieldsSchema.extend({ id: UuidSchema }).strict();

export const TaskChangesSchema = TaskFieldsSchema.partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

export const MemberSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(200),
  calendarId: CalendarIdSchema,
  dailyCapacityMinutes: z.number().int().min(1).max(1_440),
}).strict();

export const MemberChangesSchema = MemberSchema.omit({ id: true })
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "At least one change is required");

export const ApiCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.add"), task: TaskSchema }),
  z.object({ type: z.literal("task.update"), taskId: UuidSchema, changes: TaskChangesSchema }),
  z.object({ type: z.literal("task.delete"), taskId: UuidSchema }),
  z.object({
    type: z.literal("task.generateSubtasks"),
    parentTaskId: UuidSchema,
    templateId: TemplateIdSchema,
  }),
  z.object({ type: z.literal("member.add"), member: MemberSchema }),
  z.object({ type: z.literal("member.update"), memberId: UuidSchema, changes: MemberChangesSchema }),
  z.object({ type: z.literal("member.delete"), memberId: UuidSchema }),
]);

function toTask(task: z.infer<typeof TaskSchema>): ProjectTask {
  return {
    id: task.id,
    parentId: task.parentId,
    sortOrder: task.sortOrder,
    name: task.name,
    process: task.process,
    product: task.product,
    reviewRef: task.reviewRef,
    changeRef: task.changeRef,
    note: task.note,
    contract: task.contract,
    assigneeMemberId: task.assigneeMemberId,
    plannedEffortMinutes: task.plannedEffortMinutes,
    progressBasisPoints: task.progressBasisPoints,
    actualEffortMinutes: task.actualEffortMinutes,
    prorationWeightBp: task.prorationWeightBp,
    dailyPlan: { ...task.dailyPlan },
    dailyPlanLocked: task.dailyPlanLocked,
    actualStart: task.actualStart,
    actualFinish: task.actualFinish,
    dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
  };
}

function toTaskChanges(
  changes: z.infer<typeof TaskChangesSchema>,
): Partial<Omit<ProjectTask, "id">> {
  return {
    ...(changes.parentId === undefined ? {} : { parentId: changes.parentId }),
    ...(changes.sortOrder === undefined ? {} : { sortOrder: changes.sortOrder }),
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.process === undefined ? {} : { process: changes.process }),
    ...(changes.product === undefined ? {} : { product: changes.product }),
    ...(changes.reviewRef === undefined ? {} : { reviewRef: changes.reviewRef }),
    ...(changes.changeRef === undefined ? {} : { changeRef: changes.changeRef }),
    ...(changes.note === undefined ? {} : { note: changes.note }),
    ...(changes.contract === undefined ? {} : { contract: changes.contract }),
    ...(changes.assigneeMemberId === undefined
      ? {}
      : { assigneeMemberId: changes.assigneeMemberId }),
    ...(changes.plannedEffortMinutes === undefined
      ? {}
      : { plannedEffortMinutes: changes.plannedEffortMinutes }),
    ...(changes.progressBasisPoints === undefined
      ? {}
      : { progressBasisPoints: changes.progressBasisPoints }),
    ...(changes.actualEffortMinutes === undefined
      ? {}
      : { actualEffortMinutes: changes.actualEffortMinutes }),
    ...(changes.prorationWeightBp === undefined
      ? {}
      : { prorationWeightBp: changes.prorationWeightBp }),
    ...(changes.dailyPlan === undefined ? {} : { dailyPlan: { ...changes.dailyPlan } }),
    ...(changes.dailyPlanLocked === undefined
      ? {}
      : { dailyPlanLocked: changes.dailyPlanLocked }),
    ...(changes.actualStart === undefined ? {} : { actualStart: changes.actualStart }),
    ...(changes.actualFinish === undefined ? {} : { actualFinish: changes.actualFinish }),
    ...(changes.dependencies === undefined
      ? {}
      : { dependencies: changes.dependencies.map((dependency) => ({ ...dependency })) }),
  };
}

export function toCommand(command: z.infer<typeof ApiCommandSchema>): ProjectCommand {
  if (command.type === "task.add") {
    return { type: command.type, task: toTask(command.task) };
  }
  if (command.type === "task.update") {
    return { type: command.type, taskId: command.taskId, changes: toTaskChanges(command.changes) };
  }
  if (command.type === "task.delete") {
    return command;
  }
  if (command.type === "task.generateSubtasks") {
    return { type: command.type, parentTaskId: command.parentTaskId, templateId: command.templateId };
  }
  if (command.type === "member.add") {
    return { type: command.type, member: { ...command.member } };
  }
  if (command.type === "member.update") {
    return {
      type: command.type,
      memberId: command.memberId,
      changes: {
        ...(command.changes.name === undefined ? {} : { name: command.changes.name }),
        ...(command.changes.calendarId === undefined
          ? {}
          : { calendarId: command.changes.calendarId }),
        ...(command.changes.dailyCapacityMinutes === undefined
          ? {}
          : { dailyCapacityMinutes: command.changes.dailyCapacityMinutes }),
      },
    };
  }
  return command;
}

function fromTask(task: ProjectTask): z.infer<typeof TaskSchema> {
  return {
    id: task.id,
    parentId: task.parentId,
    sortOrder: task.sortOrder,
    name: task.name,
    process: task.process,
    product: task.product,
    reviewRef: task.reviewRef,
    changeRef: task.changeRef,
    note: task.note,
    contract: task.contract,
    assigneeMemberId: task.assigneeMemberId,
    plannedEffortMinutes: task.plannedEffortMinutes,
    progressBasisPoints: task.progressBasisPoints,
    actualEffortMinutes: task.actualEffortMinutes,
    prorationWeightBp: task.prorationWeightBp,
    dailyPlan: { ...task.dailyPlan },
    dailyPlanLocked: task.dailyPlanLocked,
    actualStart: task.actualStart,
    actualFinish: task.actualFinish,
    dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
  };
}

function fromTaskChanges(
  changes: Partial<Omit<ProjectTask, "id">>,
): z.infer<typeof TaskChangesSchema> {
  return {
    ...(changes.parentId === undefined ? {} : { parentId: changes.parentId }),
    ...(changes.sortOrder === undefined ? {} : { sortOrder: changes.sortOrder }),
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.process === undefined ? {} : { process: changes.process }),
    ...(changes.product === undefined ? {} : { product: changes.product }),
    ...(changes.reviewRef === undefined ? {} : { reviewRef: changes.reviewRef }),
    ...(changes.changeRef === undefined ? {} : { changeRef: changes.changeRef }),
    ...(changes.note === undefined ? {} : { note: changes.note }),
    ...(changes.contract === undefined ? {} : { contract: changes.contract }),
    ...(changes.assigneeMemberId === undefined
      ? {}
      : { assigneeMemberId: changes.assigneeMemberId }),
    ...(changes.plannedEffortMinutes === undefined
      ? {}
      : { plannedEffortMinutes: changes.plannedEffortMinutes }),
    ...(changes.progressBasisPoints === undefined
      ? {}
      : { progressBasisPoints: changes.progressBasisPoints }),
    ...(changes.actualEffortMinutes === undefined
      ? {}
      : { actualEffortMinutes: changes.actualEffortMinutes }),
    ...(changes.prorationWeightBp === undefined
      ? {}
      : { prorationWeightBp: changes.prorationWeightBp }),
    ...(changes.dailyPlan === undefined ? {} : { dailyPlan: { ...changes.dailyPlan } }),
    ...(changes.dailyPlanLocked === undefined
      ? {}
      : { dailyPlanLocked: changes.dailyPlanLocked }),
    ...(changes.actualStart === undefined ? {} : { actualStart: changes.actualStart }),
    ...(changes.actualFinish === undefined ? {} : { actualFinish: changes.actualFinish }),
    ...(changes.dependencies === undefined
      ? {}
      : { dependencies: changes.dependencies.map((dependency) => ({ ...dependency })) }),
  };
}

export function fromCommand(command: ProjectCommand): z.infer<typeof ApiCommandSchema> {
  if (command.type === "task.add") {
    return { type: command.type, task: fromTask(command.task) };
  }
  if (command.type === "task.update") {
    return {
      type: command.type,
      taskId: command.taskId,
      changes: fromTaskChanges(command.changes),
    };
  }
  if (command.type === "task.delete") {
    return command;
  }
  if (command.type === "task.generateSubtasks") {
    return { type: command.type, parentTaskId: command.parentTaskId, templateId: command.templateId };
  }
  if (command.type === "member.add") {
    return { type: command.type, member: { ...command.member } };
  }
  if (command.type === "member.update") {
    return {
      type: command.type,
      memberId: command.memberId,
      changes: { ...command.changes },
    };
  }
  return command;
}
