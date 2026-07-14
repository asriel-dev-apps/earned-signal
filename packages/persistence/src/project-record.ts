export type MeasurementMethod = "ZERO_HUNDRED" | "PHYSICAL_PERCENT";
export type DependencyType = "FS" | "SS" | "FF" | "SF";

export interface TenantRecord {
  readonly id: string;
  readonly name: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly currency: string;
  readonly timezone: string;
  readonly projectStart: string;
  readonly statusDate: string;
  readonly revision: bigint;
}

export interface WbsNodeRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface ActivityRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly wbsNodeId: string;
  readonly name: string;
  readonly owner: string;
  readonly durationWorkingDays: number;
  readonly budgetMinor: bigint;
  readonly measurementMethod: MeasurementMethod;
  readonly sortOrder: number;
}

export interface DependencyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly predecessorActivityId: string;
  readonly successorActivityId: string;
  readonly type: DependencyType;
  readonly lagWorkingDays: number;
}

export interface ProgressMeasurementRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly activityId: string;
  readonly measurementDate: string;
  readonly method: MeasurementMethod;
  readonly progressBasisPoints: number;
}

export interface WorklogRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly activityId: string;
  readonly workDate: string;
  readonly actualMinutes: number;
  readonly rateMinorPerHour: string;
  readonly personRef: string;
}

export interface DirectActualCostRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly activityId: string;
  readonly costDate: string;
  readonly amountMinor: bigint;
  readonly description: string;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly projectRevision: bigint;
  readonly actorType: "HUMAN" | "AGENT" | "SYSTEM";
  readonly actorId: string;
  readonly commandType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface BaselineVersionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly version: number;
  readonly label: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
}

export interface BaselineWbsNodeRecord extends Omit<WbsNodeRecord, "parentId"> {
  readonly baselineVersionId: string;
  readonly sourceWbsNodeId: string;
  readonly parentSourceWbsNodeId: string | null;
}

export interface BaselineActivityRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly baselineVersionId: string;
  readonly sourceActivityId: string;
  readonly sourceWbsNodeId: string;
  readonly wbsCode: string;
  readonly name: string;
  readonly durationWorkingDays: number;
  readonly baselineStart: string;
  readonly baselineFinish: string;
  readonly budgetMinor: bigint;
  readonly measurementMethod: MeasurementMethod;
}

export interface BaselineDependencyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly baselineVersionId: string;
  readonly predecessorSourceActivityId: string;
  readonly successorSourceActivityId: string;
  readonly type: DependencyType;
  readonly lagWorkingDays: number;
}

export interface BaselineRecord {
  readonly version: BaselineVersionRecord;
  readonly wbsNodes: readonly BaselineWbsNodeRecord[];
  readonly activities: readonly BaselineActivityRecord[];
  readonly dependencies: readonly BaselineDependencyRecord[];
}

export interface PersistedProjectRecord {
  readonly tenant: TenantRecord;
  readonly project: ProjectRecord;
  readonly wbsNodes: readonly WbsNodeRecord[];
  readonly activities: readonly ActivityRecord[];
  readonly dependencies: readonly DependencyRecord[];
  readonly progressMeasurements: readonly ProgressMeasurementRecord[];
  readonly worklogs: readonly WorklogRecord[];
  readonly directActualCosts: readonly DirectActualCostRecord[];
  readonly auditEvents: readonly AuditEventRecord[];
  readonly baseline: BaselineRecord | null;
}
