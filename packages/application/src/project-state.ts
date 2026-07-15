import {
  calculateSchedule,
  MAX_ACTIVITY_DURATION_WORKING_DAYS,
  type DependencyType,
  type ScheduleConstraintInput,
} from "@earned-signal/domain";

export interface ProjectCalendar {
  readonly id: string;
  readonly name: string;
  readonly workingWeekdays: readonly number[];
  readonly nonWorkingDates: readonly string[];
}

export interface ProjectWbsGroup {
  readonly id: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
}

export interface ProjectDependency {
  readonly predecessorId: string;
  readonly type: DependencyType;
  readonly lagWorkingDays: number;
}

export interface ProjectTask {
  readonly id: string;
  readonly wbs: string;
  readonly wbsParentId: string | null;
  readonly name: string;
  readonly owner: string;
  readonly durationWorkingDays: number;
  readonly measurementMethod: "ZERO_HUNDRED" | "PHYSICAL_PERCENT";
  readonly calendarId: string;
  readonly dependencies: readonly ProjectDependency[];
  readonly constraint: ScheduleConstraintInput | null;
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
  readonly defaultCalendarId: string;
  readonly calendars: readonly ProjectCalendar[];
  readonly wbsGroups: readonly ProjectWbsGroup[];
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
  const wbsGroupIds = new Set(project.wbsGroups.map((group) => group.id));
  if (wbsGroupIds.size !== project.wbsGroups.length) {
    throw new Error("WBS group IDs must be unique");
  }
  const wbsCodes = new Set<string>();
  for (const group of project.wbsGroups) {
    if (group.id.trim().length === 0 || group.code.trim().length === 0 || group.name.trim().length === 0) {
      throw new Error("WBS groups require an ID, code, and name");
    }
    if (wbsCodes.has(group.code)) throw new Error(`WBS code must be unique: ${group.code}`);
    wbsCodes.add(group.code);
    if (group.parentId !== null && !wbsGroupIds.has(group.parentId)) {
      throw new Error(`Unknown WBS parent: ${group.parentId}`);
    }
    const visited = new Set([group.id]);
    let parentId = group.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) throw new Error("WBS hierarchy contains a cycle");
      visited.add(parentId);
      parentId = project.wbsGroups.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
  }

  const ids = new Set<string>();
  for (const task of project.tasks) {
    if (task.id.length === 0 || ids.has(task.id)) {
      throw new Error(`Task ID must be unique: ${task.id}`);
    }
    ids.add(task.id);
    if (task.wbs.trim().length === 0 || wbsCodes.has(task.wbs)) {
      throw new Error(`WBS code must be unique: ${task.wbs}`);
    }
    wbsCodes.add(task.wbs);
    if (task.wbsParentId !== null && !wbsGroupIds.has(task.wbsParentId)) {
      throw new Error(`Unknown WBS parent: ${task.wbsParentId}`);
    }
    if (
      !Number.isInteger(task.durationWorkingDays) ||
      task.durationWorkingDays < 1 ||
      task.durationWorkingDays > MAX_ACTIVITY_DURATION_WORKING_DAYS
    ) {
      throw new Error(
        `Duration must be a whole number from 1 to ${MAX_ACTIVITY_DURATION_WORKING_DAYS}`,
      );
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
    if (
      task.measurementMethod === "ZERO_HUNDRED" &&
      task.progressPercent !== 0 &&
      task.progressPercent !== 100
    ) {
      throw new Error("0/100 progress must be either 0 or 100");
    }
  }

  calculateSchedule({
    projectStart: project.projectStart,
    defaultCalendarId: project.defaultCalendarId,
    calendars: project.calendars,
    activities: project.tasks.map((task) => ({
      id: task.id,
      durationWorkingDays: task.durationWorkingDays,
      calendarId: task.calendarId,
      dependencies: task.dependencies,
      ...(task.constraint === null ? {} : { constraint: task.constraint }),
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
