export interface WorklogCost {
  readonly workDate: string;
  readonly minutes: number;
  readonly ratePerMinute: number;
}

interface WorkPackageBase {
  readonly id: string;
  readonly baselineBudget: number;
  readonly baselineStart: string;
  readonly baselineFinish: string;
  readonly measurementDate: string;
  readonly worklogs: readonly WorklogCost[];
}

export interface ZeroHundredWorkPackage extends WorkPackageBase {
  readonly measurementMethod: "ZERO_HUNDRED";
  readonly completed: boolean;
}

export interface PhysicalPercentWorkPackage extends WorkPackageBase {
  readonly measurementMethod: "PHYSICAL_PERCENT";
  readonly physicalPercent: number;
}

export type EvmWorkPackage = ZeroHundredWorkPackage | PhysicalPercentWorkPackage;

export interface EvmInput {
  readonly statusDate: string;
  readonly workPackages: readonly EvmWorkPackage[];
}

export interface EvmResult {
  readonly bac: number;
  readonly pv: number;
  readonly ev: number;
  readonly ac: number;
  readonly sv: number;
  readonly cv: number;
  readonly spi: number | null;
  readonly cpi: number | null;
  readonly eac: number | null;
  readonly etc: number | null;
  readonly vac: number | null;
  readonly tcpi: number | null;
}

const DAY_IN_MILLISECONDS = 86_400_000;

function asUtcDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ISO calendar date: ${value}`);
  }
  return date;
}

function workingDaysThrough(start: Date, finish: Date): number {
  let count = 0;
  for (
    let cursor = start;
    cursor.getTime() <= finish.getTime();
    cursor = new Date(cursor.getTime() + DAY_IN_MILLISECONDS)
  ) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      count += 1;
    }
  }
  return count;
}

function plannedFraction(
  baselineStart: string,
  baselineFinish: string,
  statusDate: string,
): number {
  const start = asUtcDate(baselineStart);
  const finish = asUtcDate(baselineFinish);
  const status = asUtcDate(statusDate);
  if (finish.getTime() < start.getTime()) {
    throw new Error("Baseline finish must not precede baseline start");
  }
  if (status.getTime() < start.getTime()) {
    return 0;
  }
  const totalDays = workingDaysThrough(start, finish);
  if (totalDays === 0) {
    throw new Error("Baseline must contain at least one working day");
  }
  const effectiveFinish = status.getTime() < finish.getTime() ? status : finish;
  return workingDaysThrough(start, effectiveFinish) / totalDays;
}

function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function validateWorkPackage(workPackage: EvmWorkPackage): void {
  if (workPackage.baselineBudget < 0 || !Number.isFinite(workPackage.baselineBudget)) {
    throw new Error(`Work package ${workPackage.id} has an invalid baseline budget`);
  }
  if (
    workPackage.measurementMethod === "PHYSICAL_PERCENT" &&
    (!Number.isFinite(workPackage.physicalPercent) ||
      workPackage.physicalPercent < 0 ||
      workPackage.physicalPercent > 100)
  ) {
    throw new Error(`Work package ${workPackage.id} physical percent must be from 0 to 100`);
  }
  for (const worklog of workPackage.worklogs) {
    asUtcDate(worklog.workDate);
    if (
      !Number.isFinite(worklog.minutes) ||
      !Number.isFinite(worklog.ratePerMinute) ||
      worklog.minutes < 0 ||
      worklog.ratePerMinute < 0
    ) {
      throw new Error(`Work package ${workPackage.id} has an invalid actual cost input`);
    }
  }
  asUtcDate(workPackage.measurementDate);
}

export function calculateEvm(input: EvmInput): EvmResult {
  asUtcDate(input.statusDate);
  let bac = 0;
  let pv = 0;
  let ev = 0;
  let ac = 0;

  for (const workPackage of input.workPackages) {
    validateWorkPackage(workPackage);
    bac += workPackage.baselineBudget;
    pv +=
      workPackage.baselineBudget *
      plannedFraction(
        workPackage.baselineStart,
        workPackage.baselineFinish,
        input.statusDate,
      );
    const measurementIsCurrent = workPackage.measurementDate <= input.statusDate;
    const earnedFraction = measurementIsCurrent
      ? workPackage.measurementMethod === "ZERO_HUNDRED"
        ? workPackage.completed
          ? 1
          : 0
        : workPackage.physicalPercent / 100
      : 0;
    ev += workPackage.baselineBudget * earnedFraction;
    ac += workPackage.worklogs
      .filter((worklog) => worklog.workDate <= input.statusDate)
      .reduce(
        (total, worklog) => total + worklog.minutes * worklog.ratePerMinute,
        0,
      );
  }

  const rawSpi = ratio(ev, pv);
  const rawCpi = ratio(ev, ac);
  const rawEac = rawCpi === null || rawCpi === 0 ? null : bac / rawCpi;
  const rawTcpi = ratio(bac - ev, bac - ac);

  return {
    bac: round(bac, 2),
    pv: round(pv, 2),
    ev: round(ev, 2),
    ac: round(ac, 2),
    sv: round(ev - pv, 2),
    cv: round(ev - ac, 2),
    spi: rawSpi === null ? null : round(rawSpi, 4),
    cpi: rawCpi === null ? null : round(rawCpi, 4),
    eac: rawEac === null ? null : round(rawEac, 2),
    etc: rawEac === null ? null : round(rawEac - ac, 2),
    vac: rawEac === null ? null : round(bac - rawEac, 2),
    tcpi: rawTcpi === null ? null : round(rawTcpi, 4),
  };
}
