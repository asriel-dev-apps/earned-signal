import {
  calculateEffortEvm,
  type EffortRollup,
  type TaskStatus,
} from "@earned-signal/domain";
import type { ProjectState } from "./project-state.js";

/**
 * Viewer role for the WBS-grid projection. The projection is the single choke
 * point where ⑦ strips role-sensitive fields (member capacity, and the Phase-2
 * rate) for the general role. The seam is placed here; the filtering itself is
 * implemented in ⑦ and is a no-op in step ②.
 */
export type ProjectionRole = "PRIVILEGED" | "GENERAL";

export interface WbsGridTaskRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly sortOrder: number;
  // Meta columns B/C/D-F/E/G/H/I/J.
  readonly name: string;
  readonly process: string;
  readonly product: string;
  readonly reviewRef: string;
  readonly changeRef: string;
  readonly note: string;
  readonly contract: string;
  readonly assigneeMemberId: string | null;
  readonly assigneeName: string | null;
  // Stored inputs L/T/W/R/S and the daily plot.
  readonly plannedEffortMinutes: number;
  readonly progressBasisPoints: number;
  readonly actualEffortMinutes: number;
  readonly actualStart: string | null;
  readonly actualFinish: string | null;
  readonly dailyPlan: Readonly<Record<string, number>>;
  readonly dailyPlanLocked: boolean;
  // Derived columns K/M/N/O/P/Q/T/U/V/W(hours)/X (from the effort EVM module).
  readonly plannedEffortDays: number;
  readonly plannedEffortHours: number;
  readonly plannedEarnedHours: number;
  readonly plannedProgress: number;
  readonly plannedStart: string | null;
  readonly plannedFinish: string | null;
  readonly progress: number;
  readonly status: TaskStatus;
  readonly earnedEffortHours: number;
  readonly actualEffortHours: number;
  readonly costVarianceHours: number;
}

export interface WbsGridProjection {
  readonly projectId: string;
  readonly statusDate: string;
  readonly rows: readonly WbsGridTaskRow[];
  readonly rollup: EffortRollup;
}

export interface WbsGridProjectionOptions {
  readonly role?: ProjectionRole;
}

export function projectWbsGrid(
  project: ProjectState,
  options: WbsGridProjectionOptions = {},
): WbsGridProjection {
  const role = options.role ?? "PRIVILEGED";
  const memberNameById = new Map(project.members.map((member) => [member.id, member.name]));

  const effort = calculateEffortEvm({
    statusDate: project.statusDate,
    tasks: project.tasks.map((task) => ({
      id: task.id,
      plannedEffortMinutes: task.plannedEffortMinutes,
      progressBasisPoints: task.progressBasisPoints,
      actualEffortMinutes: task.actualEffortMinutes,
      dailyPlan: task.dailyPlan,
    })),
  });
  const metricsById = new Map(effort.tasks.map((metrics) => [metrics.id, metrics]));

  const rows = project.tasks
    .map((task): WbsGridTaskRow => {
      const metrics = metricsById.get(task.id);
      if (metrics === undefined) {
        throw new Error(`Missing effort metrics for task ${task.id}`);
      }
      return {
        id: task.id,
        parentId: task.parentId,
        sortOrder: task.sortOrder,
        name: task.name,
        process: task.process,
        product: task.product,
        reviewRef: task.reviewRef,
        changeRef: task.changeRef,
        note: task.note,
        contract: task.contract,
        assigneeMemberId: task.assigneeMemberId,
        assigneeName:
          task.assigneeMemberId === null
            ? null
            : memberNameById.get(task.assigneeMemberId) ?? null,
        plannedEffortMinutes: task.plannedEffortMinutes,
        progressBasisPoints: task.progressBasisPoints,
        actualEffortMinutes: task.actualEffortMinutes,
        actualStart: task.actualStart,
        actualFinish: task.actualFinish,
        dailyPlan: task.dailyPlan,
        dailyPlanLocked: task.dailyPlanLocked,
        plannedEffortDays: metrics.plannedEffortDays,
        plannedEffortHours: metrics.plannedEffortHours,
        plannedEarnedHours: metrics.plannedEarnedHours,
        plannedProgress: metrics.plannedProgress,
        plannedStart: metrics.plannedStart,
        plannedFinish: metrics.plannedFinish,
        progress: metrics.progress,
        status: metrics.status,
        earnedEffortHours: metrics.earnedEffortHours,
        actualEffortHours: metrics.actualEffortHours,
        costVarianceHours: metrics.costVarianceHours,
      };
    })
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));

  // ⑦ role seam: the GENERAL role will strip role-sensitive fields (member
  // capacity, Phase-2 rate) from the projection here. Not filtered in step ②.
  void role;

  return {
    projectId: project.id,
    statusDate: project.statusDate,
    rows,
    rollup: effort.rollup,
  };
}
