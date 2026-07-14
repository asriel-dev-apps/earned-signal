import { calculateSchedule } from "@earned-signal/domain";

export interface ProjectTask {
  readonly id: string;
  readonly wbs: string;
  readonly name: string;
  readonly owner: string;
  readonly durationWorkingDays: number;
  readonly predecessorId: string | null;
  readonly budget: number;
  readonly progressPercent: number;
  readonly actualCost: number;
  readonly actualMinutes: number;
}

export interface ProjectState {
  readonly id: string;
  readonly name: string;
  readonly projectStart: string;
  readonly statusDate: string;
  readonly currency: "JPY";
  readonly tasks: readonly ProjectTask[];
}

export interface UpdateTaskCommand {
  readonly type: "task.update";
  readonly taskId: string;
  readonly changes: Partial<Omit<ProjectTask, "id">>;
}

export interface AddTaskCommand {
  readonly type: "task.add";
  readonly task: ProjectTask;
}

export interface DeleteTaskCommand {
  readonly type: "task.delete";
  readonly taskId: string;
}

export type ProjectCommand =
  | UpdateTaskCommand
  | AddTaskCommand
  | DeleteTaskCommand;

function validateFiniteNonNegative(value: number, message: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(message);
  }
}

function validateSafeMinorUnits(value: number, field: string): void {
  validateFiniteNonNegative(value, `${field} must not be negative`);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be stored as safe whole minor units`);
  }
}

function validateProject(project: ProjectState): void {
  const ids = new Set<string>();
  for (const task of project.tasks) {
    if (task.id.length === 0 || ids.has(task.id)) {
      throw new Error(`Task ID must be unique: ${task.id}`);
    }
    ids.add(task.id);
    if (!Number.isInteger(task.durationWorkingDays) || task.durationWorkingDays < 1) {
      throw new Error("Duration must be a positive whole number");
    }
    validateSafeMinorUnits(task.budget, "Budget");
    validateSafeMinorUnits(task.actualCost, "Actual cost");
    validateFiniteNonNegative(task.actualMinutes, "Actual effort must not be negative");
    if (!Number.isInteger(task.actualMinutes)) {
      throw new Error("Actual effort must be stored as whole minutes");
    }
    if (
      !Number.isFinite(task.progressPercent) ||
      task.progressPercent < 0 ||
      task.progressPercent > 100
    ) {
      throw new Error("Progress must be between 0 and 100");
    }
  }

  calculateSchedule({
    projectStart: project.projectStart,
    activities: project.tasks.map((task) => ({
      id: task.id,
      durationWorkingDays: task.durationWorkingDays,
      dependencies:
        task.predecessorId === null
          ? []
          : [{ predecessorId: task.predecessorId, lagWorkingDays: 0 }],
    })),
  });
}

export function applyProjectCommand(
  state: ProjectState,
  command: ProjectCommand,
): ProjectState {
  let next: ProjectState;
  if (command.type === "task.add") {
    next = { ...state, tasks: [...state.tasks, command.task] };
  } else if (command.type === "task.delete") {
    if (!state.tasks.some((task) => task.id === command.taskId)) {
      throw new Error(`Unknown task: ${command.taskId}`);
    }
    next = {
      ...state,
      tasks: state.tasks.filter((task) => task.id !== command.taskId),
    };
  } else {
    if (!state.tasks.some((task) => task.id === command.taskId)) {
      throw new Error(`Unknown task: ${command.taskId}`);
    }
    next = {
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === command.taskId ? { ...task, ...command.changes } : task,
      ),
    };
  }
  validateProject(next);
  return next;
}
