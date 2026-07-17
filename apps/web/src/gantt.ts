const DAY_IN_MILLISECONDS = 86_400_000;

export interface GanttScale {
  readonly start: string;
  readonly finish: string;
  readonly dayCount: number;
  readonly ticks: readonly string[];
}

interface DateRange {
  readonly start: string;
  readonly finish: string;
}

interface DependencyNode {
  readonly id: string;
  readonly critical: boolean;
  readonly drivingDependencies: readonly {
    readonly predecessorId: string;
    readonly type?: "FS" | "SS" | "FF" | "SF";
    readonly lagWorkingDays: number;
  }[];
}

export interface CriticalDependencyEdge {
  readonly predecessorId: string;
  readonly successorId: string;
  readonly type: "FS" | "SS" | "FF" | "SF";
  readonly lagWorkingDays: number;
}

function dateValue(value: string): number {
  const time = new Date(`${value}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(time)) throw new Error(`Invalid Gantt date: ${value}`);
  return time;
}

function dateAt(start: number, offset: number): string {
  return new Date(start + offset * DAY_IN_MILLISECONDS).toISOString().slice(0, 10);
}

export function buildGanttScale(ranges: readonly DateRange[]): GanttScale {
  if (ranges.length === 0) throw new Error("A Gantt scale requires at least one activity");
  const start = Math.min(...ranges.map((range) => dateValue(range.start)));
  const finish = Math.max(...ranges.map((range) => dateValue(range.finish)));
  if (finish < start) throw new Error("Gantt finish must not precede start");
  const dayCount = Math.round((finish - start) / DAY_IN_MILLISECONDS) + 1;
  const tickCount = Math.min(6, dayCount);
  const offsets = Array.from({ length: tickCount }, (_, index) =>
    tickCount === 1 ? 0 : Math.round(((dayCount - 1) * index) / (tickCount - 1)),
  );
  return {
    start: dateAt(start, 0),
    finish: dateAt(start, dayCount - 1),
    dayCount,
    ticks: [...new Set(offsets)].map((offset) => dateAt(start, offset)),
  };
}

export function ganttPosition(
  start: string,
  finish: string,
  scale: GanttScale,
): { readonly left: number; readonly width: number } {
  const scaleStart = dateValue(scale.start);
  const activityStart = dateValue(start);
  const activityFinish = dateValue(finish);
  if (activityFinish < activityStart) throw new Error("Activity finish must not precede start");
  const leftDays = (activityStart - scaleStart) / DAY_IN_MILLISECONDS;
  const durationDays = (activityFinish - activityStart) / DAY_IN_MILLISECONDS + 1;
  return {
    left: (leftDays / scale.dayCount) * 100,
    width: (durationDays / scale.dayCount) * 100,
  };
}

export function criticalDependencyEdges(
  tasks: readonly DependencyNode[],
): readonly CriticalDependencyEdge[] {
  const criticalIds = new Set(tasks.filter((task) => task.critical).map((task) => task.id));
  return tasks.flatMap((task) => {
    if (!criticalIds.has(task.id)) return [];
    return task.drivingDependencies
      .filter((dependency) => criticalIds.has(dependency.predecessorId))
      .map((dependency) => ({
        predecessorId: dependency.predecessorId,
        successorId: task.id,
        type: dependency.type ?? "FS",
        lagWorkingDays: dependency.lagWorkingDays,
      }));
  });
}
