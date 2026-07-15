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
  readonly defaultCalendarId: string;
  readonly revision: bigint;
}

export interface ProjectCalendarRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly id: string;
  readonly name: string;
  readonly workingWeekdays: readonly number[];
  readonly nonWorkingDates: readonly string[];
}

export interface SkillRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
}

export interface ResourceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly calendarId: string;
  readonly dailyCapacityMinutes: number;
  readonly costRateMinorPerHour: bigint;
}

export interface ResourceSkillRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly skillId: string;
}

export interface ActivitySkillRequirementRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly activityId: string;
  readonly skillId: string;
}

export interface AssignmentRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly activityId: string;
  readonly resourceId: string;
  readonly unitsPercent: number;
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
  readonly calendarId: string;
  readonly constraintType:
    | "START_NO_EARLIER_THAN"
    | "FINISH_NO_LATER_THAN"
    | "MUST_START_ON"
    | "MUST_FINISH_ON"
    | null;
  readonly constraintDate: string | null;
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
  readonly defaultCalendarId: string;
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
  readonly calendarId: string;
  readonly constraintType: ActivityRecord["constraintType"];
  readonly constraintDate: string | null;
  readonly baselineStart: string;
  readonly baselineFinish: string;
  readonly budgetMinor: bigint;
  readonly measurementMethod: MeasurementMethod;
}

export interface BaselineCalendarRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly baselineVersionId: string;
  readonly sourceCalendarId: string;
  readonly name: string;
  readonly workingWeekdays: readonly number[];
  readonly nonWorkingDates: readonly string[];
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
  readonly calendars: readonly BaselineCalendarRecord[];
  readonly wbsNodes: readonly BaselineWbsNodeRecord[];
  readonly activities: readonly BaselineActivityRecord[];
  readonly dependencies: readonly BaselineDependencyRecord[];
}

export interface PersistedProjectRecord {
  readonly tenant: TenantRecord;
  readonly project: ProjectRecord;
  readonly calendars: readonly ProjectCalendarRecord[];
  readonly skills: readonly SkillRecord[];
  readonly resources: readonly ResourceRecord[];
  readonly resourceSkills: readonly ResourceSkillRecord[];
  readonly wbsNodes: readonly WbsNodeRecord[];
  readonly activities: readonly ActivityRecord[];
  readonly activitySkillRequirements: readonly ActivitySkillRequirementRecord[];
  readonly assignments: readonly AssignmentRecord[];
  readonly dependencies: readonly DependencyRecord[];
  readonly progressMeasurements: readonly ProgressMeasurementRecord[];
  readonly worklogs: readonly WorklogRecord[];
  readonly directActualCosts: readonly DirectActualCostRecord[];
  readonly auditEvents: readonly AuditEventRecord[];
  readonly baseline: BaselineRecord | null;
}
