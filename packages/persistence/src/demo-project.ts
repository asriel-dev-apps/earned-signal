import type {
  ActivityRecord,
  PersistedProjectRecord,
  WbsNodeRecord,
} from "./project-record.js";

const tenantId = "00000000-0000-4000-8000-00000000d001";
const projectId = "10000000-0000-4000-8000-00000000d001";
const baselineVersionId = "40000000-0000-4000-8000-00000000d001";

function entityId(prefix: number, sequence: number): string {
  return `${prefix.toString(16)}0000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

const taskDefinitions = [
  { code: "1.1", name: "Confirm launch requirements", owner: "Maya Chen", currentDuration: 5, baselineDuration: 5, budgetMinor: 600_000n, predecessor: null, baselineStart: "2026-07-13", baselineFinish: "2026-07-17", progressBasisPoints: 10_000, actualMinutes: 2_760, actualCostMinor: 650_000n },
  { code: "1.2", name: "Approve experience flows", owner: "Leo Martin", currentDuration: 4, baselineDuration: 4, budgetMinor: 400_000n, predecessor: 1, baselineStart: "2026-07-20", baselineFinish: "2026-07-23", progressBasisPoints: 10_000, actualMinutes: 2_100, actualCostMinor: 450_000n },
  { code: "2.1", name: "Build account API", owner: "Noah Williams", currentDuration: 7, baselineDuration: 6, budgetMinor: 900_000n, predecessor: 1, baselineStart: "2026-07-20", baselineFinish: "2026-07-27", progressBasisPoints: 6_500, actualMinutes: 4_080, actualCostMinor: 800_000n },
  { code: "2.2", name: "Build customer workspace", owner: "Leo Martin", currentDuration: 10, baselineDuration: 8, budgetMinor: 950_000n, predecessor: 2, baselineStart: "2026-07-24", baselineFinish: "2026-08-04", progressBasisPoints: 4_500, actualMinutes: 3_660, actualCostMinor: 700_000n },
  { code: "2.3", name: "Integrate UI and API", owner: "Noah Williams", currentDuration: 6, baselineDuration: 5, budgetMinor: 650_000n, predecessor: 4, baselineStart: "2026-08-05", baselineFinish: "2026-08-11", progressBasisPoints: 1_000, actualMinutes: 720, actualCostMinor: 100_000n },
  { code: "2.4", name: "Prepare customer data", owner: "Maya Chen", currentDuration: 4, baselineDuration: 4, budgetMinor: 350_000n, predecessor: 3, baselineStart: "2026-07-28", baselineFinish: "2026-07-31", progressBasisPoints: 2_000, actualMinutes: 960, actualCostMinor: 120_000n },
  { code: "3.1", name: "Run acceptance testing", owner: "Maya Chen", currentDuration: 5, baselineDuration: 5, budgetMinor: 500_000n, predecessor: 5, baselineStart: "2026-08-12", baselineFinish: "2026-08-18", progressBasisPoints: 0, actualMinutes: 0, actualCostMinor: 0n },
  { code: "3.2", name: "Train support team", owner: "Leo Martin", currentDuration: 3, baselineDuration: 3, budgetMinor: 250_000n, predecessor: 6, baselineStart: "2026-08-03", baselineFinish: "2026-08-05", progressBasisPoints: 0, actualMinutes: 0, actualCostMinor: 0n },
  { code: "3.3", name: "Launch customer portal", owner: "Noah Williams", currentDuration: 1, baselineDuration: 1, budgetMinor: 100_000n, predecessor: 7, baselineStart: "2026-08-19", baselineFinish: "2026-08-19", progressBasisPoints: 0, actualMinutes: 0, actualCostMinor: 0n },
] as const;

const summaryDefinitions = [
  ["1", "Discovery and design"],
  ["2", "Build and integration"],
  ["3", "Launch readiness"],
] as const;

const summaryIdByCode = new Map<string, string>(
  summaryDefinitions.map(([code], index) => [code, entityId(2, index + 1)]),
);

const wbsNodes: readonly WbsNodeRecord[] = [
  ...summaryDefinitions.map(([code, name], index) => ({
    id: entityId(2, index + 1),
    tenantId,
    projectId,
    parentId: null,
    code,
    name,
    sortOrder: index,
  })),
  ...taskDefinitions.map(({ code, name }, index) => ({
    id: entityId(2, index + 101),
    tenantId,
    projectId,
    parentId: summaryIdByCode.get(code.split(".")[0] ?? "")!,
    code,
    name,
    sortOrder: index,
  })),
].sort((left, right) => left.code.localeCompare(right.code));

const activities: readonly ActivityRecord[] = taskDefinitions.map(
  ({ name, owner, currentDuration, budgetMinor }, index) => ({
    id: entityId(3, index + 1),
    tenantId,
    projectId,
    wbsNodeId: entityId(2, index + 101),
    name,
    owner,
    durationWorkingDays: currentDuration,
    calendarId: "standard",
    constraintType: null,
    constraintDate: null,
    budgetMinor,
    measurementMethod: "PHYSICAL_PERCENT",
    sortOrder: index,
  }),
);

const skillIds = {
  delivery: entityId(13, 1),
  api: entityId(13, 2),
  ux: entityId(13, 3),
} as const;

const resourceIds = {
  maya: entityId(14, 1),
  leo: entityId(14, 2),
  noah: entityId(14, 3),
} as const;

const resourceIdByOwner: Readonly<Record<string, string>> = {
  "Maya Chen": resourceIds.maya,
  "Leo Martin": resourceIds.leo,
  "Noah Williams": resourceIds.noah,
};

const requiredSkillByTask = [
  skillIds.delivery,
  skillIds.ux,
  skillIds.api,
  skillIds.ux,
  skillIds.api,
  skillIds.delivery,
  skillIds.delivery,
  skillIds.delivery,
  skillIds.delivery,
] as const;

export const demoProjectRecord: PersistedProjectRecord = {
  tenant: { id: tenantId, name: "EarnedSignal demo" },
  project: {
    id: projectId,
    tenantId,
    name: "Customer portal launch",
    currency: "JPY",
    timezone: "Asia/Tokyo",
    projectStart: "2026-07-13",
    statusDate: "2026-08-07",
    defaultCalendarId: "standard",
    revision: 1n,
  },
  calendars: [{
    tenantId,
    projectId,
    id: "standard",
    name: "Standard working week",
    workingWeekdays: [1, 2, 3, 4, 5],
    nonWorkingDates: [],
  }, {
    tenantId,
    projectId,
    id: "support",
    name: "Support Tuesday–Saturday",
    workingWeekdays: [2, 3, 4, 5, 6],
    nonWorkingDates: ["2026-08-11"],
  }],
  skills: [
    { id: skillIds.delivery, tenantId, projectId, name: "Delivery management" },
    { id: skillIds.api, tenantId, projectId, name: "API engineering" },
    { id: skillIds.ux, tenantId, projectId, name: "Experience design" },
  ],
  resources: [
    {
      id: resourceIds.maya,
      tenantId,
      projectId,
      name: "Maya Chen",
      calendarId: "standard",
      dailyCapacityMinutes: 480,
      costRateMinorPerHour: 6_000n,
    },
    {
      id: resourceIds.leo,
      tenantId,
      projectId,
      name: "Leo Martin",
      calendarId: "support",
      dailyCapacityMinutes: 420,
      costRateMinorPerHour: 6_500n,
    },
    {
      id: resourceIds.noah,
      tenantId,
      projectId,
      name: "Noah Williams",
      calendarId: "standard",
      dailyCapacityMinutes: 480,
      costRateMinorPerHour: 7_000n,
    },
  ],
  resourceSkills: [
    { tenantId, projectId, resourceId: resourceIds.maya, skillId: skillIds.delivery },
    { tenantId, projectId, resourceId: resourceIds.leo, skillId: skillIds.delivery },
    { tenantId, projectId, resourceId: resourceIds.leo, skillId: skillIds.ux },
    { tenantId, projectId, resourceId: resourceIds.noah, skillId: skillIds.api },
  ],
  wbsNodes,
  activities,
  activitySkillRequirements: activities.map((activity, index) => ({
    tenantId,
    projectId,
    activityId: activity.id,
    skillId: requiredSkillByTask[index]!,
  })),
  assignments: taskDefinitions.map(({ owner }, index) => ({
    tenantId,
    projectId,
    activityId: entityId(3, index + 1),
    resourceId: resourceIdByOwner[owner]!,
    unitsPercent: 100,
  })),
  dependencies: taskDefinitions.flatMap(({ predecessor }, index) =>
    predecessor === null
      ? []
      : [{
          id: entityId(5, index + 1),
          tenantId,
          projectId,
          predecessorActivityId: entityId(3, predecessor),
          successorActivityId: entityId(3, index + 1),
          type: "FS" as const,
          lagWorkingDays: 0,
        }],
  ),
  progressMeasurements: taskDefinitions.map(({ progressBasisPoints }, index) => ({
    id: entityId(6, index + 1),
    tenantId,
    projectId,
    activityId: entityId(3, index + 1),
    measurementDate: "2026-08-07",
    method: "PHYSICAL_PERCENT",
    progressBasisPoints,
  })),
  worklogs: taskDefinitions.flatMap(({ owner, actualMinutes }, index) =>
    actualMinutes === 0
      ? []
      : [{
          id: entityId(7, index + 1),
          tenantId,
          projectId,
          activityId: entityId(3, index + 1),
          workDate: "2026-08-07",
          actualMinutes,
          rateMinorPerHour: "0.000000",
          personRef: owner,
        }],
  ),
  directActualCosts: taskDefinitions.flatMap(({ name, actualCostMinor }, index) =>
    actualCostMinor === 0n
      ? []
      : [{
          id: entityId(8, index + 1),
          tenantId,
          projectId,
          activityId: entityId(3, index + 1),
          costDate: "2026-08-07",
          amountMinor: actualCostMinor,
          description: `${name} actual cost`,
        }],
  ),
  auditEvents: [
    {
      id: entityId(12, 1),
      tenantId,
      projectId,
      projectRevision: 1n,
      actorType: "HUMAN",
      actorId: "demo-planner",
      commandType: "baseline.approve",
      payload: { baselineVersionId },
      occurredAt: "2026-07-13T00:00:00.000Z",
    },
  ],
  baseline: {
    version: {
      id: baselineVersionId,
      tenantId,
      projectId,
      version: 1,
      label: "Approved launch plan",
      defaultCalendarId: "standard",
      approvedAt: "2026-07-13T00:00:00.000Z",
      approvedBy: "demo-planner",
    },
    calendars: [{
      tenantId,
      projectId,
      baselineVersionId,
      sourceCalendarId: "standard",
      name: "Standard working week",
      workingWeekdays: [1, 2, 3, 4, 5],
      nonWorkingDates: [],
    }, {
      tenantId,
      projectId,
      baselineVersionId,
      sourceCalendarId: "support",
      name: "Support Tuesday–Saturday",
      workingWeekdays: [2, 3, 4, 5, 6],
      nonWorkingDates: ["2026-08-11"],
    }],
    skills: [
      { sourceSkillId: skillIds.delivery, name: "Delivery management" },
      { sourceSkillId: skillIds.api, name: "API engineering" },
      { sourceSkillId: skillIds.ux, name: "Experience design" },
    ].map((skill) => ({ tenantId, projectId, baselineVersionId, ...skill })),
    resources: [
      { sourceResourceId: resourceIds.maya, name: "Maya Chen", calendarId: "standard", dailyCapacityMinutes: 480, costRateMinorPerHour: 6_000n },
      { sourceResourceId: resourceIds.leo, name: "Leo Martin", calendarId: "support", dailyCapacityMinutes: 420, costRateMinorPerHour: 6_500n },
      { sourceResourceId: resourceIds.noah, name: "Noah Williams", calendarId: "standard", dailyCapacityMinutes: 480, costRateMinorPerHour: 7_000n },
    ].map((resource) => ({ tenantId, projectId, baselineVersionId, ...resource })),
    resourceSkills: [
      { sourceResourceId: resourceIds.maya, sourceSkillId: skillIds.delivery },
      { sourceResourceId: resourceIds.leo, sourceSkillId: skillIds.delivery },
      { sourceResourceId: resourceIds.leo, sourceSkillId: skillIds.ux },
      { sourceResourceId: resourceIds.noah, sourceSkillId: skillIds.api },
    ].map((link) => ({ tenantId, projectId, baselineVersionId, ...link })),
    wbsNodes: wbsNodes.map((node, index) => ({
      id: entityId(9, index + 1),
      tenantId,
      projectId,
      baselineVersionId,
      sourceWbsNodeId: node.id,
      parentSourceWbsNodeId: node.parentId,
      code: node.code,
      name: node.name,
      sortOrder: node.sortOrder,
    })),
    activities: taskDefinitions.map(
      ({ code, name, baselineDuration, budgetMinor, baselineStart, baselineFinish }, index) => ({
        id: entityId(10, index + 1),
        tenantId,
        projectId,
        baselineVersionId,
        sourceActivityId: entityId(3, index + 1),
        sourceWbsNodeId: entityId(2, index + 101),
        wbsCode: code,
        name,
        owner: activities[index]!.owner,
        durationWorkingDays: baselineDuration,
        calendarId: "standard",
        constraintType: null,
        constraintDate: null,
        baselineStart,
        baselineFinish,
        budgetMinor,
        measurementMethod: "PHYSICAL_PERCENT",
      }),
    ),
    activitySkillRequirements: activities.map((activity, index) => ({
      tenantId,
      projectId,
      baselineVersionId,
      sourceActivityId: activity.id,
      sourceSkillId: requiredSkillByTask[index]!,
    })),
    assignments: taskDefinitions.map(({ owner }, index) => ({
      tenantId,
      projectId,
      baselineVersionId,
      sourceActivityId: entityId(3, index + 1),
      sourceResourceId: resourceIdByOwner[owner]!,
      unitsPercent: 100,
    })),
    dependencies: taskDefinitions.flatMap(({ predecessor }, index) =>
      predecessor === null
        ? []
        : [{
            id: entityId(11, index + 1),
            tenantId,
            projectId,
            baselineVersionId,
            predecessorSourceActivityId: entityId(3, predecessor),
            successorSourceActivityId: entityId(3, index + 1),
            type: "FS" as const,
            lagWorkingDays: 0,
          }],
    ),
  },
};
