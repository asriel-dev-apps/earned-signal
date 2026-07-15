import {
  calculateEvmHistory,
  type EvmResult,
  type EvmSnapshot,
} from "@earned-signal/domain";
import {
  and,
  asc,
  eq,
  isNotNull,
  type ExtractTablesWithRelations,
} from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  baselineVersions,
  evmSnapshots,
  evmSnapshotWbsVariances,
  periodBuckets,
  projects,
  schema,
} from "./schema.js";
import type { PersistedProjectRecord } from "./project-record.js";
import { ProjectRepository } from "./project-repository.js";

export function calculateProjectPerformance(
  record: PersistedProjectRecord,
): readonly EvmSnapshot[] {
  if (record.baseline === null) return [];
  return calculateEvmHistory({
    projectStart: record.project.projectStart,
    statusDate: record.project.statusDate,
    workPackages: record.baseline.activities.map((baselineActivity) => ({
      id: baselineActivity.sourceActivityId,
      wbs: baselineActivity.wbsCode,
      baselineBudget: Number(baselineActivity.budgetMinor),
      baselineStart: baselineActivity.baselineStart,
      baselineFinish: baselineActivity.baselineFinish,
      measurementMethod: baselineActivity.measurementMethod,
      measurements: record.progressMeasurements
        .filter((measurement) => measurement.activityId === baselineActivity.sourceActivityId)
        .map((measurement) => ({
          measurementDate: measurement.measurementDate,
          progressBasisPoints: measurement.progressBasisPoints,
        })),
      worklogs: record.worklogs
        .filter((worklog) => worklog.activityId === baselineActivity.sourceActivityId)
        .map((worklog) => ({
          workDate: worklog.workDate,
          minutes: worklog.actualMinutes,
          ratePerMinute: Number(worklog.rateMinorPerHour) / 60,
        })),
      actualCosts: record.directActualCosts
        .filter((cost) => cost.activityId === baselineActivity.sourceActivityId)
        .map((cost) => ({ costDate: cost.costDate, amount: Number(cost.amountMinor) })),
    })),
  });
}

function serializeFiniteDecimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error("EVM snapshot contains a non-finite value");
  return String(value);
}

function serializeNullableDecimal(value: number | null): string | null {
  return value === null ? null : serializeFiniteDecimal(value);
}

function parseStoredDecimal(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error("Stored EVM snapshot is not finite");
  return result;
}

function parseNullableDecimal(value: string | null): number | null {
  return value === null ? null : parseStoredDecimal(value);
}

function metrics(row: typeof evmSnapshots.$inferSelect): EvmResult {
  return {
    bac: parseStoredDecimal(row.bac),
    pv: parseStoredDecimal(row.pv),
    ev: parseStoredDecimal(row.ev),
    ac: parseStoredDecimal(row.ac),
    sv: parseStoredDecimal(row.sv),
    cv: parseStoredDecimal(row.cv),
    spi: parseNullableDecimal(row.spi),
    cpi: parseNullableDecimal(row.cpi),
    eac: parseNullableDecimal(row.eac),
    etc: parseNullableDecimal(row.etc),
    vac: parseNullableDecimal(row.vac),
    tcpi: parseNullableDecimal(row.tcpi),
  };
}

type ProjectTransaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

async function lockProject(
  transaction: ProjectTransaction,
  tenantId: string,
  projectId: string,
): Promise<boolean> {
  const [project] = await transaction
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
    .for("update")
    .limit(1);
  return project !== undefined;
}

async function replaceSnapshots(
  transaction: ProjectTransaction,
  tenantId: string,
  projectId: string,
  baselineVersionId: string,
  snapshots: readonly EvmSnapshot[],
): Promise<void> {
  const [approvedBaseline] = await transaction
    .select({ id: baselineVersions.id })
    .from(baselineVersions)
    .where(
      and(
        eq(baselineVersions.tenantId, tenantId),
        eq(baselineVersions.projectId, projectId),
        eq(baselineVersions.id, baselineVersionId),
        isNotNull(baselineVersions.approvedAt),
      ),
    )
    .limit(1);
  if (approvedBaseline === undefined) {
    throw new Error("EVM snapshots require an approved baseline version");
  }
  await transaction
    .delete(periodBuckets)
    .where(and(eq(periodBuckets.tenantId, tenantId), eq(periodBuckets.projectId, projectId)));
  for (const snapshot of snapshots) {
    await transaction.insert(periodBuckets).values({
      tenantId,
      projectId,
      ...snapshot.period,
    });
    await transaction.insert(evmSnapshots).values({
      tenantId,
      projectId,
      statusDate: snapshot.period.statusDate,
      baselineVersionId,
      bac: serializeFiniteDecimal(snapshot.metrics.bac),
      pv: serializeFiniteDecimal(snapshot.metrics.pv),
      ev: serializeFiniteDecimal(snapshot.metrics.ev),
      ac: serializeFiniteDecimal(snapshot.metrics.ac),
      sv: serializeFiniteDecimal(snapshot.metrics.sv),
      cv: serializeFiniteDecimal(snapshot.metrics.cv),
      spi: serializeNullableDecimal(snapshot.metrics.spi),
      cpi: serializeNullableDecimal(snapshot.metrics.cpi),
      eac: serializeNullableDecimal(snapshot.metrics.eac),
      etc: serializeNullableDecimal(snapshot.metrics.etc),
      vac: serializeNullableDecimal(snapshot.metrics.vac),
      tcpi: serializeNullableDecimal(snapshot.metrics.tcpi),
    });
    if (snapshot.wbsVariances.length > 0) {
      await transaction.insert(evmSnapshotWbsVariances).values(
        snapshot.wbsVariances.map((variance, index) => ({
          tenantId,
          projectId,
          statusDate: snapshot.period.statusDate,
          activityId: variance.id,
          wbs: variance.wbs,
          rank: index + 1,
          pv: serializeFiniteDecimal(variance.pv),
          ev: serializeFiniteDecimal(variance.ev),
          ac: serializeFiniteDecimal(variance.ac),
          sv: serializeFiniteDecimal(variance.sv),
          cv: serializeFiniteDecimal(variance.cv),
        })),
      );
    }
  }
}

export class ProjectPerformanceRepository {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async calculate(tenantId: string, projectId: string): Promise<readonly EvmSnapshot[]> {
    const record = await new ProjectRepository(this.database).load(tenantId, projectId);
    return record === null ? [] : calculateProjectPerformance(record);
  }

  async refresh(tenantId: string, projectId: string): Promise<readonly EvmSnapshot[]> {
    return this.database.transaction(async (transaction) => {
      if (!(await lockProject(transaction, tenantId, projectId))) return [];
      const record = await new ProjectRepository(transaction).load(tenantId, projectId);
      if (record === null || record.baseline === null) return [];
      const snapshots = calculateProjectPerformance(record);
      await replaceSnapshots(
        transaction,
        tenantId,
        projectId,
        record.baseline.version.id,
        snapshots,
      );
      return snapshots;
    });
  }

  async replace(
    tenantId: string,
    projectId: string,
    baselineVersionId: string,
    snapshots: readonly EvmSnapshot[],
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockProject(transaction, tenantId, projectId);
      await replaceSnapshots(
        transaction,
        tenantId,
        projectId,
        baselineVersionId,
        snapshots,
      );
    });
  }

  async load(tenantId: string, projectId: string): Promise<readonly EvmSnapshot[]> {
    const snapshotRows = await this.database
      .select()
      .from(evmSnapshots)
      .innerJoin(
        periodBuckets,
        and(
          eq(periodBuckets.tenantId, evmSnapshots.tenantId),
          eq(periodBuckets.projectId, evmSnapshots.projectId),
          eq(periodBuckets.statusDate, evmSnapshots.statusDate),
        ),
      )
      .where(and(eq(evmSnapshots.tenantId, tenantId), eq(evmSnapshots.projectId, projectId)))
      .orderBy(asc(evmSnapshots.statusDate));
    const varianceRows = await this.database
      .select()
      .from(evmSnapshotWbsVariances)
      .where(
        and(
          eq(evmSnapshotWbsVariances.tenantId, tenantId),
          eq(evmSnapshotWbsVariances.projectId, projectId),
        ),
      )
      .orderBy(
        asc(evmSnapshotWbsVariances.statusDate),
        asc(evmSnapshotWbsVariances.rank),
      );
    return snapshotRows.map(({ evm_snapshots: snapshot, period_buckets: period }) => ({
      period: {
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        statusDate: period.statusDate,
      },
      metrics: metrics(snapshot),
      wbsVariances: varianceRows
        .filter((variance) => variance.statusDate === snapshot.statusDate)
        .map((variance) => ({
          id: variance.activityId,
          wbs: variance.wbs,
          pv: parseStoredDecimal(variance.pv),
          ev: parseStoredDecimal(variance.ev),
          ac: parseStoredDecimal(variance.ac),
          sv: parseStoredDecimal(variance.sv),
          cv: parseStoredDecimal(variance.cv),
        })),
    }));
  }
}
