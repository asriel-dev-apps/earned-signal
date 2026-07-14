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
  ["1.1", "Confirm launch requirements", "Maya Chen", 5, 5, 600_000n, null, "2026-07-13", "2026-07-17", 10_000, 2_760, 650_000n],
  ["1.2", "Approve experience flows", "Leo Martin", 4, 4, 400_000n, 1, "2026-07-20", "2026-07-23", 10_000, 2_100, 450_000n],
  ["2.1", "Build account API", "Noah Williams", 7, 6, 900_000n, 1, "2026-07-20", "2026-07-27", 6_500, 4_080, 800_000n],
  ["2.2", "Build customer workspace", "Leo Martin", 10, 8, 950_000n, 2, "2026-07-24", "2026-08-04", 4_500, 3_660, 700_000n],
  ["2.3", "Integrate UI and API", "Noah Williams", 6, 5, 650_000n, 4, "2026-08-05", "2026-08-11", 1_000, 720, 100_000n],
  ["2.4", "Prepare customer data", "Maya Chen", 4, 4, 350_000n, 3, "2026-07-28", "2026-07-31", 2_000, 960, 120_000n],
  ["3.1", "Run acceptance testing", "Maya Chen", 5, 5, 500_000n, 5, "2026-08-12", "2026-08-18", 0, 0, 0n],
  ["3.2", "Train support team", "Leo Martin", 3, 3, 250_000n, 6, "2026-08-03", "2026-08-05", 0, 0, 0n],
  ["3.3", "Launch customer portal", "Noah Williams", 1, 1, 100_000n, 7, "2026-08-19", "2026-08-19", 0, 0, 0n],
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
  ...taskDefinitions.map(([code, name], index) => ({
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
  ([, name, owner, currentDuration, , budgetMinor], index) => ({
    id: entityId(3, index + 1),
    tenantId,
    projectId,
    wbsNodeId: entityId(2, index + 101),
    name,
    owner,
    durationWorkingDays: currentDuration,
    budgetMinor,
    measurementMethod: "PHYSICAL_PERCENT",
    sortOrder: index,
  }),
);

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
    revision: 0n,
  },
  wbsNodes,
  activities,
  dependencies: taskDefinitions.flatMap(([, , , , , , predecessor], index) =>
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
  progressMeasurements: taskDefinitions.map(([, , , , , , , , , progress], index) => ({
    id: entityId(6, index + 1),
    tenantId,
    projectId,
    activityId: entityId(3, index + 1),
    measurementDate: "2026-08-07",
    method: "PHYSICAL_PERCENT",
    progressBasisPoints: progress,
  })),
  worklogs: taskDefinitions.flatMap(([, , owner, , , , , , , , minutes], index) =>
    minutes === 0
      ? []
      : [{
          id: entityId(7, index + 1),
          tenantId,
          projectId,
          activityId: entityId(3, index + 1),
          workDate: "2026-08-07",
          actualMinutes: minutes,
          rateMinorPerHour: "0.000000",
          personRef: owner,
        }],
  ),
  directActualCosts: taskDefinitions.flatMap(([, name, , , , , , , , , , amount], index) =>
    amount === 0n
      ? []
      : [{
          id: entityId(8, index + 1),
          tenantId,
          projectId,
          activityId: entityId(3, index + 1),
          costDate: "2026-08-07",
          amountMinor: amount,
          description: `${name} actual cost`,
        }],
  ),
  baseline: {
    version: {
      id: baselineVersionId,
      tenantId,
      projectId,
      version: 1,
      label: "Approved launch plan",
      approvedAt: "2026-07-13T00:00:00.000Z",
      approvedBy: "demo-planner",
    },
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
      ([code, name, , , baselineDuration, budgetMinor, , start, finish], index) => ({
        id: entityId(10, index + 1),
        tenantId,
        projectId,
        baselineVersionId,
        sourceActivityId: entityId(3, index + 1),
        sourceWbsNodeId: entityId(2, index + 101),
        wbsCode: code,
        name,
        durationWorkingDays: baselineDuration,
        baselineStart: start,
        baselineFinish: finish,
        budgetMinor,
        measurementMethod: "PHYSICAL_PERCENT",
      }),
    ),
    dependencies: taskDefinitions.flatMap(([, , , , , , predecessor], index) =>
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
