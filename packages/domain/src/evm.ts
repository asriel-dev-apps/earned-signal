export interface WorklogCost {
  readonly workDate: string;
  readonly minutes: number;
  readonly ratePerMinute: number;
}

export interface DirectActualCost {
  readonly costDate: string;
  readonly amount: number;
}

interface WorkPackageBase {
  readonly id: string;
  readonly baselineBudget: number;
  readonly baselineStart: string;
  readonly baselineFinish: string;
  readonly measurementDate: string;
  readonly worklogs: readonly WorklogCost[];
  readonly actualCosts?: readonly DirectActualCost[];
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

export interface EvmProgressMeasurement {
  readonly measurementDate: string;
  readonly progressBasisPoints: number;
}

export interface EvmHistoryWorkPackage {
  readonly id: string;
  readonly wbs: string;
  readonly baselineBudget: number;
  readonly baselineStart: string;
  readonly baselineFinish: string;
  readonly measurementMethod: "ZERO_HUNDRED" | "PHYSICAL_PERCENT";
  readonly measurements: readonly EvmProgressMeasurement[];
  readonly worklogs: readonly WorklogCost[];
  readonly actualCosts?: readonly DirectActualCost[];
}

export interface PeriodBucket {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly statusDate: string;
}

export interface EvmWbsVariance {
  readonly id: string;
  readonly wbs: string;
  readonly pv: number;
  readonly ev: number;
  readonly ac: number;
  readonly sv: number;
  readonly cv: number;
}

export interface EvmSnapshot {
  readonly period: PeriodBucket;
  readonly metrics: EvmResult;
  readonly wbsVariances: readonly EvmWbsVariance[];
}

export interface EvmHistoryInput {
  readonly projectStart: string;
  readonly statusDate: string;
  readonly workPackages: readonly EvmHistoryWorkPackage[];
}

const DAY_IN_MILLISECONDS = 86_400_000;

function asUtcDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ISO calendar date: ${value}`);
  }
  return date;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_IN_MILLISECONDS);
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
  for (const actualCost of workPackage.actualCosts ?? []) {
    asUtcDate(actualCost.costDate);
    if (!Number.isFinite(actualCost.amount) || actualCost.amount < 0) {
      throw new Error(`Work package ${workPackage.id} has an invalid direct actual cost`);
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
    ac += (workPackage.actualCosts ?? [])
      .filter((actualCost) => actualCost.costDate <= input.statusDate)
      .reduce((total, actualCost) => total + actualCost.amount, 0);
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

function workPackageAt(
  workPackage: EvmHistoryWorkPackage,
  statusDate: string,
): EvmWorkPackage {
  const applicableMeasurements = workPackage.measurements
    .filter((measurement) => measurement.measurementDate <= statusDate)
    .sort((left, right) => left.measurementDate.localeCompare(right.measurementDate));
  for (const measurement of workPackage.measurements) {
    asUtcDate(measurement.measurementDate);
    if (
      !Number.isInteger(measurement.progressBasisPoints) ||
      measurement.progressBasisPoints < 0 ||
      measurement.progressBasisPoints > 10_000 ||
      (workPackage.measurementMethod === "ZERO_HUNDRED" &&
        measurement.progressBasisPoints !== 0 &&
        measurement.progressBasisPoints !== 10_000)
    ) {
      throw new Error(`Work package ${workPackage.id} has an invalid progress measurement`);
    }
  }
  const latest = applicableMeasurements.at(-1);
  const base = {
    id: workPackage.id,
    baselineBudget: workPackage.baselineBudget,
    baselineStart: workPackage.baselineStart,
    baselineFinish: workPackage.baselineFinish,
    measurementDate: latest?.measurementDate ?? statusDate,
    worklogs: workPackage.worklogs,
    ...(workPackage.actualCosts === undefined ? {} : { actualCosts: workPackage.actualCosts }),
  };
  return workPackage.measurementMethod === "ZERO_HUNDRED"
    ? {
        ...base,
        measurementMethod: workPackage.measurementMethod,
        completed: latest?.progressBasisPoints === 10_000,
      }
    : {
        ...base,
        measurementMethod: workPackage.measurementMethod,
        physicalPercent: (latest?.progressBasisPoints ?? 0) / 100,
      };
}

function periodBuckets(projectStart: string, statusDate: string): readonly PeriodBucket[] {
  const start = asUtcDate(projectStart);
  const finish = asUtcDate(statusDate);
  if (finish.getTime() < start.getTime()) {
    throw new Error("Status date must not precede project start");
  }
  const buckets: PeriodBucket[] = [];
  let periodStart = start;
  while (periodStart.getTime() <= finish.getTime()) {
    const day = periodStart.getUTCDay();
    const daysThroughSunday = day === 0 ? 0 : 7 - day;
    const periodEnd = addDays(periodStart, daysThroughSunday);
    const snapshotDate = periodEnd.getTime() < finish.getTime() ? periodEnd : finish;
    buckets.push({
      periodStart: isoDate(periodStart),
      periodEnd: isoDate(periodEnd),
      statusDate: isoDate(snapshotDate),
    });
    periodStart = addDays(periodEnd, 1);
  }
  return buckets;
}

export function calculateEvmHistory(input: EvmHistoryInput): readonly EvmSnapshot[] {
  return periodBuckets(input.projectStart, input.statusDate).map((period) => {
    const workPackages = input.workPackages.map((workPackage) =>
      workPackageAt(workPackage, period.statusDate),
    );
    const wbsVariances = input.workPackages
      .map((workPackage, index): EvmWbsVariance => {
        const result = calculateEvm({
          statusDate: period.statusDate,
          workPackages: [workPackages[index]!],
        });
        return {
          id: workPackage.id,
          wbs: workPackage.wbs,
          pv: result.pv,
          ev: result.ev,
          ac: result.ac,
          sv: result.sv,
          cv: result.cv,
        };
      })
      .sort(
        (left, right) =>
          Math.abs(right.sv) + Math.abs(right.cv) -
            (Math.abs(left.sv) + Math.abs(left.cv)) ||
          left.wbs.localeCompare(right.wbs),
      );
    return {
      period,
      metrics: calculateEvm({ statusDate: period.statusDate, workPackages }),
      wbsVariances,
    };
  });
}
