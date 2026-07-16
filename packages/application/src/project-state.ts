import {
  calculateCapacity,
  calculateSchedule,
  MAX_ACTIVITY_DURATION_WORKING_DAYS,
  type DependencyType,
  type CapacityResult,
  type ScheduleConstraintInput,
  type ScheduleResult,
} from "@earned-signal/domain";
import type { ScenarioPlanCommand } from "./scenario.js";

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

export interface ProjectSkill {
  readonly id: string;
  readonly name: string;
}

export interface ProjectResource {
  readonly id: string;
  readonly name: string;
  readonly calendarId: string;
  readonly dailyCapacityMinutes: number;
  readonly costRateMinorPerHour: number;
  readonly skillIds: readonly string[];
}

export interface ProjectAssignment {
  readonly taskId: string;
  readonly resourceId: string;
  readonly unitsPercent: number;
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
  readonly requiredSkillIds: readonly string[];
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
  readonly skills: readonly ProjectSkill[];
  readonly resources: readonly ProjectResource[];
  readonly assignments: readonly ProjectAssignment[];
  readonly tasks: readonly ProjectTask[];
}

export function calculateProjectCapacity(
  project: ProjectState,
  schedule: ScheduleResult,
): CapacityResult {
  const tasks = new Map(project.tasks.map((task) => [task.id, task]));
  return calculateCapacity({
    periodStart: project.projectStart,
    periodFinish: schedule.projectFinish,
    calendars: project.calendars,
    skills: project.skills,
    resources: project.resources,
    activities: schedule.activities.map((activity) => ({
      id: activity.id,
      start: activity.earlyStart,
      finish: activity.earlyFinish,
      requiredSkillIds: tasks.get(activity.id)?.requiredSkillIds ?? [],
    })),
    assignments: project.assignments.map((assignment) => ({
      activityId: assignment.taskId,
      resourceId: assignment.resourceId,
      unitsPercent: assignment.unitsPercent,
    })),
  });
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

export interface AddResourceCommand {
  readonly type: "resource.add";
  readonly resource: ProjectResource;
}

export interface UpdateResourceCommand {
  readonly type: "resource.update";
  readonly resourceId: string;
  readonly changes: Partial<Omit<ProjectResource, "id">>;
}

export interface DeleteResourceCommand {
  readonly type: "resource.delete";
  readonly resourceId: string;
}

export interface ReplaceTaskAssignmentsCommand {
  readonly type: "assignment.replace";
  readonly taskId: string;
  readonly assignments: readonly Omit<ProjectAssignment, "taskId">[];
}

export interface PublishBaselineCommand {
  readonly type: "baseline.publish";
  readonly label: string;
}

export interface PublishScenarioCommand {
  readonly type: "scenario.publish";
  readonly scenarioId: string;
  readonly scenarioRevision: string;
  readonly sourceProjectRevision: string;
  readonly changes: readonly ScenarioPlanCommand[];
}

export type ProjectCommand =
  | UpdateTaskCommand
  | AddTaskCommand
  | DeleteTaskCommand
  | AddResourceCommand
  | UpdateResourceCommand
  | DeleteResourceCommand
  | ReplaceTaskAssignmentsCommand
  | PublishBaselineCommand
  | PublishScenarioCommand;

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
  const skillIds = new Set(project.skills.map((skill) => skill.id));
  if (
    skillIds.size !== project.skills.length ||
    project.skills.some((skill) => skill.id.trim().length === 0 || skill.name.trim().length === 0)
  ) {
    throw new Error("Skills require unique non-blank IDs and names");
  }
  const resourceIds = new Set(project.resources.map((resource) => resource.id));
  if (resourceIds.size !== project.resources.length) {
    throw new Error("Resource IDs must be unique");
  }
  for (const resource of project.resources) {
    if (resource.name.trim().length === 0) {
      throw new Error(`Resource ${resource.id} requires a name`);
    }
  }
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
      new Set(task.requiredSkillIds).size !== task.requiredSkillIds.length ||
      task.requiredSkillIds.some((skillId) => !skillIds.has(skillId))
    ) {
      throw new Error(`Task ${task.id} has invalid required skills`);
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

  const schedule = calculateSchedule({
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
  calculateProjectCapacity(project, schedule);
}

export function applyProjectCommand(
  state: ProjectState,
  command: ProjectCommand,
): ProjectState {
  let next: ProjectState;
  if (command.type === "scenario.publish") {
    if (command.changes.length === 0) throw new Error("Scenario publication requires plan changes");
    next = command.changes.reduce<ProjectState>((project, change) => {
      if (change.type === "task.update") {
        const fields = Object.keys(change.changes);
        if (fields.some((field) => field === "progressPercent" || field === "actualCost" || field === "actualMinutes")) {
          throw new Error("Scenario commands cannot change progress or actuals");
        }
      }
      if (change.type === "task.add" && (change.task.progressPercent !== 0 || change.task.actualCost !== 0 || change.task.actualMinutes !== 0)) {
        throw new Error("Scenario commands cannot add progress or actuals");
      }
      return applyProjectCommand(project, change);
    }, state);
  } else if (command.type === "baseline.publish") {
    if (command.label.trim().length === 0) throw new Error("Baseline label must not be blank");
    next = state;
  } else if (command.type === "resource.add") {
    next = { ...state, resources: [...state.resources, command.resource] };
  } else if (command.type === "resource.update") {
    if (Object.keys(command.changes).length === 0) {
      throw new Error("Resource update requires at least one change");
    }
    if (!state.resources.some((resource) => resource.id === command.resourceId)) {
      throw new Error(`Unknown resource: ${command.resourceId}`);
    }
    next = {
      ...state,
      resources: state.resources.map((resource) =>
        resource.id === command.resourceId ? { ...resource, ...command.changes } : resource,
      ),
    };
  } else if (command.type === "resource.delete") {
    if (!state.resources.some((resource) => resource.id === command.resourceId)) {
      throw new Error(`Unknown resource: ${command.resourceId}`);
    }
    if (state.assignments.some((assignment) => assignment.resourceId === command.resourceId)) {
      throw new Error(`Resource ${command.resourceId} has assignments`);
    }
    next = {
      ...state,
      resources: state.resources.filter((resource) => resource.id !== command.resourceId),
    };
  } else if (command.type === "assignment.replace") {
    if (!state.tasks.some((task) => task.id === command.taskId)) {
      throw new Error(`Unknown task: ${command.taskId}`);
    }
    next = {
      ...state,
      assignments: [
        ...state.assignments.filter((assignment) => assignment.taskId !== command.taskId),
        ...command.assignments.map((assignment) => ({ taskId: command.taskId, ...assignment })),
      ],
    };
  } else if (command.type === "task.add") {
    next = { ...state, tasks: [...state.tasks, command.task] };
  } else if (command.type === "task.delete") {
    if (!state.tasks.some((task) => task.id === command.taskId)) {
      throw new Error(`Unknown task: ${command.taskId}`);
    }
    next = {
      ...state,
      tasks: state.tasks.filter((task) => task.id !== command.taskId),
      assignments: state.assignments.filter((assignment) => assignment.taskId !== command.taskId),
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
