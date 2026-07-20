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

export interface MemberRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly calendarId: string;
  readonly dailyCapacityMinutes: number;
}

export interface TaskRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly parentTaskId: string | null;
  readonly sortOrder: number;
  readonly name: string;
  readonly process: string;
  readonly product: string;
  readonly reviewRef: string;
  readonly changeRef: string;
  readonly note: string;
  readonly contract: string;
  readonly assigneeMemberId: string | null;
  readonly plannedEffortMinutes: number;
  readonly progressBasisPoints: number;
  readonly actualEffortMinutes: number;
  /** Basis-point proration weight (0–10000) for template-generated subtasks; null otherwise. */
  readonly prorationWeightBp: number | null;
  readonly dailyPlan: Readonly<Record<string, number>>;
  readonly dailyPlanLocked: boolean;
  readonly actualStart: string | null;
  readonly actualFinish: string | null;
}

export interface TaskDependencyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly predecessorTaskId: string;
  readonly successorTaskId: string;
  readonly type: DependencyType;
  readonly lagWorkingDays: number;
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

export interface PersistedProjectRecord {
  readonly tenant: TenantRecord;
  readonly project: ProjectRecord;
  readonly calendars: readonly ProjectCalendarRecord[];
  readonly members: readonly MemberRecord[];
  readonly tasks: readonly TaskRecord[];
  readonly dependencies: readonly TaskDependencyRecord[];
  readonly auditEvents: readonly AuditEventRecord[];
}
