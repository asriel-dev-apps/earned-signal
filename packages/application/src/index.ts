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
  readonly actualHours: number;
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

export function applyProjectCommand(
  state: ProjectState,
  command: ProjectCommand,
): ProjectState {
  if (command.type === "task.add") {
    return { ...state, tasks: [...state.tasks, command.task] };
  }

  if (command.type === "task.delete") {
    return {
      ...state,
      tasks: state.tasks.filter((task) => task.id !== command.taskId),
    };
  }

  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === command.taskId ? { ...task, ...command.changes } : task,
    ),
  };
}
