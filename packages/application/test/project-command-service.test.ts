import { describe, expect, it } from "vitest";
import {
  createProjectCommandService,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
} from "../src/index.js";

const initialProject: ProjectState = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "API project",
  projectStart: "2026-07-13",
  statusDate: "2026-07-24",
  currency: "JPY",
  defaultCalendarId: "calendar-standard",
  calendars: [
    {
      id: "calendar-standard",
      name: "Standard",
      workingWeekdays: [1, 2, 3, 4, 5],
      nonWorkingDates: [],
    },
  ],
  wbsGroups: [],
  skills: [],
  resources: [],
  assignments: [],
  tasks: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      wbs: "1.1",
      wbsParentId: null,
      name: "Build API",
      owner: "Maya Chen",
      durationWorkingDays: 5,
      measurementMethod: "PHYSICAL_PERCENT",
      calendarId: "calendar-standard",
      dependencies: [],
      constraint: null,
      requiredSkillIds: [],
      budget: 600_000,
      progressPercent: 20,
      actualCost: 100_000,
      actualMinutes: 600,
    },
  ],
};

class InMemoryProjectCommandUnitOfWork implements ProjectCommandUnitOfWork {
  private project = initialProject;

  async execute(
    request: ProjectCommandRequest,
    transition: (project: ProjectState) => ProjectState,
  ): Promise<ProjectCommandExecution> {
    this.project = transition(this.project);
    return {
      projectId: request.projectId,
      revision: request.expectedRevision + 1n,
      replayed: false,
    };
  }

  readProject(): ProjectState {
    return this.project;
  }
}

describe("ProjectCommandService", () => {
  it("applies a validated project command through the shared transaction boundary", async () => {
    const unitOfWork = new InMemoryProjectCommandUnitOfWork();
    const service = createProjectCommandService(unitOfWork);

    const result = await service.execute({
      tenantId: "00000000-0000-4000-8000-000000000001",
      projectId: initialProject.id,
      expectedRevision: 4n,
      idempotencyKey: "command-001",
      actor: { type: "HUMAN", id: "user-001" },
      command: {
        type: "task.update",
        taskId: initialProject.tasks[0]!.id,
        changes: { progressPercent: 55, actualMinutes: 900 },
      },
    });

    expect(result).toEqual({
      projectId: initialProject.id,
      revision: 5n,
      replayed: false,
    });
    expect(unitOfWork.readProject().tasks[0]).toMatchObject({
      progressPercent: 55,
      actualMinutes: 900,
    });
  });
});
