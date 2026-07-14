import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const measurementMethod = pgEnum("measurement_method", [
  "ZERO_HUNDRED",
  "PHYSICAL_PERCENT",
]);

export const dependencyType = pgEnum("dependency_type", ["FS", "SS", "FF", "SF"]);

export const auditActorType = pgEnum("audit_actor_type", ["HUMAN", "AGENT", "SYSTEM"]);
export const principalType = pgEnum("principal_type", ["HUMAN", "AGENT"]);
export const tenantRole = pgEnum("tenant_role", ["OWNER", "ADMIN", "MEMBER"]);
export const projectRole = pgEnum("project_role", ["OWNER", "EDITOR", "VIEWER"]);

const auditTimestamp = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string", precision: 6 });

export const principals = pgTable(
  "principals",
  {
    id: uuid().primaryKey().defaultRandom(),
    issuer: text().notNull(),
    subject: text().notNull(),
    type: principalType().notNull(),
    displayName: text("display_name").notNull(),
    allowedScopes: text("allowed_scopes").array().notNull().default(sql`array[]::text[]`),
    disabledAt: auditTimestamp("disabled_at"),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("principals_issuer_subject_unique").on(table.issuer, table.subject),
    check("principals_issuer_not_blank", sql`length(trim(${table.issuer})) > 0`),
    check("principals_subject_not_blank", sql`length(trim(${table.subject})) > 0`),
    check("principals_display_name_not_blank", sql`length(trim(${table.displayName})) > 0`),
    check(
      "principals_allowed_scopes_known",
      sql`${table.allowedScopes} <@ array['project:progress:write', 'project:actuals:write']::text[]`,
    ),
    check(
      "principals_human_scopes_empty",
      sql`${table.type} <> 'HUMAN' or cardinality(${table.allowedScopes}) = 0`,
    ),
  ],
);

export const tenants = pgTable("tenants", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
});

export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    role: tenantRole().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.principalId] }),
    index("tenant_memberships_principal_idx").on(table.principalId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text().notNull(),
    currency: char({ length: 3 }).notNull().default("JPY"),
    timezone: text().notNull().default("Asia/Tokyo"),
    projectStart: date("project_start", { mode: "string" }).notNull(),
    statusDate: date("status_date", { mode: "string" }).notNull(),
    revision: bigint({ mode: "bigint" }).notNull().default(sql`0`),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("projects_tenant_id_id_unique").on(table.tenantId, table.id),
    index("projects_tenant_id_idx").on(table.tenantId),
    check("projects_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("projects_currency_uppercase", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("projects_revision_non_negative", sql`${table.revision} >= 0`),
    check("projects_status_after_start", sql`${table.statusDate} >= ${table.projectStart}`),
  ],
);

export const projectMemberships = pgTable(
  "project_memberships",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    role: projectRole().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.principalId] }),
    index("project_memberships_principal_idx").on(table.principalId),
    foreignKey({
      name: "project_memberships_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "project_memberships_tenant_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.principalId],
    }).onDelete("cascade"),
  ],
);

export const wbsNodes = pgTable(
  "wbs_nodes",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    parentId: uuid("parent_id"),
    code: text().notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("wbs_nodes_tenant_project_id_unique").on(
      table.tenantId,
      table.projectId,
      table.id,
    ),
    uniqueIndex("wbs_nodes_project_code_unique").on(
      table.tenantId,
      table.projectId,
      table.code,
    ),
    index("wbs_nodes_parent_idx").on(table.tenantId, table.projectId, table.parentId),
    foreignKey({
      name: "wbs_nodes_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "wbs_nodes_parent_fk",
      columns: [table.tenantId, table.projectId, table.parentId],
      foreignColumns: [table.tenantId, table.projectId, table.id],
    }).onDelete("restrict"),
    check("wbs_nodes_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("wbs_nodes_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("wbs_nodes_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
    check("wbs_nodes_not_own_parent", sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`),
  ],
);

export const activities = pgTable(
  "activities",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    wbsNodeId: uuid("wbs_node_id").notNull(),
    name: text().notNull(),
    owner: text().notNull().default(""),
    durationWorkingDays: integer("duration_working_days").notNull(),
    budgetMinor: bigint("budget_minor", { mode: "bigint" }).notNull(),
    measurementMethod: measurementMethod("measurement_method").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("activities_tenant_project_id_unique").on(
      table.tenantId,
      table.projectId,
      table.id,
    ),
    index("activities_wbs_node_idx").on(table.tenantId, table.projectId, table.wbsNodeId),
    foreignKey({
      name: "activities_wbs_node_fk",
      columns: [table.tenantId, table.projectId, table.wbsNodeId],
      foreignColumns: [wbsNodes.tenantId, wbsNodes.projectId, wbsNodes.id],
    }).onDelete("restrict"),
    check("activities_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("activities_duration_positive", sql`${table.durationWorkingDays} > 0`),
    check("activities_budget_non_negative", sql`${table.budgetMinor} >= 0`),
    check("activities_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

export const dependencies = pgTable(
  "dependencies",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    predecessorActivityId: uuid("predecessor_activity_id").notNull(),
    successorActivityId: uuid("successor_activity_id").notNull(),
    type: dependencyType().notNull().default("FS"),
    lagWorkingDays: integer("lag_working_days").notNull().default(0),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("dependencies_edge_unique").on(
      table.tenantId,
      table.projectId,
      table.predecessorActivityId,
      table.successorActivityId,
      table.type,
    ),
    index("dependencies_successor_idx").on(
      table.tenantId,
      table.projectId,
      table.successorActivityId,
    ),
    foreignKey({
      name: "dependencies_predecessor_fk",
      columns: [table.tenantId, table.projectId, table.predecessorActivityId],
      foreignColumns: [activities.tenantId, activities.projectId, activities.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "dependencies_successor_fk",
      columns: [table.tenantId, table.projectId, table.successorActivityId],
      foreignColumns: [activities.tenantId, activities.projectId, activities.id],
    }).onDelete("cascade"),
    check(
      "dependencies_distinct_activities",
      sql`${table.predecessorActivityId} <> ${table.successorActivityId}`,
    ),
    check("dependencies_lag_non_negative", sql`${table.lagWorkingDays} >= 0`),
  ],
);

export const baselineVersions = pgTable(
  "baseline_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    version: integer().notNull(),
    label: text().notNull(),
    approvedAt: auditTimestamp("approved_at"),
    approvedBy: text("approved_by"),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("baseline_versions_tenant_project_id_unique").on(
      table.tenantId,
      table.projectId,
      table.id,
    ),
    uniqueIndex("baseline_versions_project_version_unique").on(
      table.tenantId,
      table.projectId,
      table.version,
    ),
    foreignKey({
      name: "baseline_versions_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("restrict"),
    check("baseline_versions_version_positive", sql`${table.version} > 0`),
    check("baseline_versions_label_not_blank", sql`length(trim(${table.label})) > 0`),
    check(
      "baseline_versions_approval_complete",
      sql`(${table.approvedAt} is null and ${table.approvedBy} is null) or (${table.approvedAt} is not null and length(trim(${table.approvedBy})) > 0)`,
    ),
  ],
);

export const baselineWbsNodes = pgTable(
  "baseline_wbs_nodes",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    sourceWbsNodeId: uuid("source_wbs_node_id").notNull(),
    parentSourceWbsNodeId: uuid("parent_source_wbs_node_id"),
    code: text().notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("baseline_wbs_nodes_snapshot_source_unique").on(
      table.tenantId,
      table.projectId,
      table.baselineVersionId,
      table.sourceWbsNodeId,
    ),
    foreignKey({
      name: "baseline_wbs_nodes_version_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId],
      foreignColumns: [
        baselineVersions.tenantId,
        baselineVersions.projectId,
        baselineVersions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "baseline_wbs_nodes_parent_fk",
      columns: [
        table.tenantId,
        table.projectId,
        table.baselineVersionId,
        table.parentSourceWbsNodeId,
      ],
      foreignColumns: [
        table.tenantId,
        table.projectId,
        table.baselineVersionId,
        table.sourceWbsNodeId,
      ],
    }).onDelete("restrict"),
    check("baseline_wbs_nodes_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("baseline_wbs_nodes_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("baseline_wbs_nodes_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
    check(
      "baseline_wbs_nodes_not_own_parent",
      sql`${table.parentSourceWbsNodeId} is null or ${table.parentSourceWbsNodeId} <> ${table.sourceWbsNodeId}`,
    ),
  ],
);

export const baselineActivities = pgTable(
  "baseline_activities",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    sourceActivityId: uuid("source_activity_id").notNull(),
    sourceWbsNodeId: uuid("source_wbs_node_id").notNull(),
    wbsCode: text("wbs_code").notNull(),
    name: text().notNull(),
    durationWorkingDays: integer("duration_working_days").notNull(),
    baselineStart: date("baseline_start", { mode: "string" }).notNull(),
    baselineFinish: date("baseline_finish", { mode: "string" }).notNull(),
    budgetMinor: bigint("budget_minor", { mode: "bigint" }).notNull(),
    measurementMethod: measurementMethod("measurement_method").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("baseline_activities_source_unique").on(
      table.tenantId,
      table.projectId,
      table.baselineVersionId,
      table.sourceActivityId,
    ),
    foreignKey({
      name: "baseline_activities_version_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId],
      foreignColumns: [
        baselineVersions.tenantId,
        baselineVersions.projectId,
        baselineVersions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "baseline_activities_wbs_node_fk",
      columns: [
        table.tenantId,
        table.projectId,
        table.baselineVersionId,
        table.sourceWbsNodeId,
      ],
      foreignColumns: [
        baselineWbsNodes.tenantId,
        baselineWbsNodes.projectId,
        baselineWbsNodes.baselineVersionId,
        baselineWbsNodes.sourceWbsNodeId,
      ],
    }).onDelete("restrict"),
    check("baseline_activities_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("baseline_activities_wbs_code_not_blank", sql`length(trim(${table.wbsCode})) > 0`),
    check("baseline_activities_duration_positive", sql`${table.durationWorkingDays} > 0`),
    check("baseline_activities_budget_non_negative", sql`${table.budgetMinor} >= 0`),
    check(
      "baseline_activities_finish_after_start",
      sql`${table.baselineFinish} >= ${table.baselineStart}`,
    ),
  ],
);

export const baselineDependencies = pgTable(
  "baseline_dependencies",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    predecessorSourceActivityId: uuid("predecessor_source_activity_id").notNull(),
    successorSourceActivityId: uuid("successor_source_activity_id").notNull(),
    type: dependencyType().notNull(),
    lagWorkingDays: integer("lag_working_days").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("baseline_dependencies_edge_unique").on(
      table.tenantId,
      table.projectId,
      table.baselineVersionId,
      table.predecessorSourceActivityId,
      table.successorSourceActivityId,
      table.type,
    ),
    foreignKey({
      name: "baseline_dependencies_predecessor_fk",
      columns: [
        table.tenantId,
        table.projectId,
        table.baselineVersionId,
        table.predecessorSourceActivityId,
      ],
      foreignColumns: [
        baselineActivities.tenantId,
        baselineActivities.projectId,
        baselineActivities.baselineVersionId,
        baselineActivities.sourceActivityId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "baseline_dependencies_successor_fk",
      columns: [
        table.tenantId,
        table.projectId,
        table.baselineVersionId,
        table.successorSourceActivityId,
      ],
      foreignColumns: [
        baselineActivities.tenantId,
        baselineActivities.projectId,
        baselineActivities.baselineVersionId,
        baselineActivities.sourceActivityId,
      ],
    }).onDelete("restrict"),
    check(
      "baseline_dependencies_distinct_activities",
      sql`${table.predecessorSourceActivityId} <> ${table.successorSourceActivityId}`,
    ),
    check("baseline_dependencies_lag_non_negative", sql`${table.lagWorkingDays} >= 0`),
  ],
);

export const progressMeasurements = pgTable(
  "progress_measurements",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    activityId: uuid("activity_id").notNull(),
    measurementDate: date("measurement_date", { mode: "string" }).notNull(),
    method: measurementMethod().notNull(),
    progressBasisPoints: integer("progress_basis_points").notNull(),
    recordedAt: auditTimestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => [
    unique("progress_measurements_activity_date_unique").on(
      table.tenantId,
      table.projectId,
      table.activityId,
      table.measurementDate,
    ),
    foreignKey({
      name: "progress_measurements_activity_fk",
      columns: [table.tenantId, table.projectId, table.activityId],
      foreignColumns: [activities.tenantId, activities.projectId, activities.id],
    }).onDelete("cascade"),
    check(
      "progress_measurements_range",
      sql`${table.progressBasisPoints} between 0 and 10000`,
    ),
    check(
      "progress_measurements_zero_hundred_values",
      sql`${table.method} <> 'ZERO_HUNDRED' or ${table.progressBasisPoints} in (0, 10000)`,
    ),
  ],
);

export const worklogs = pgTable(
  "worklogs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    activityId: uuid("activity_id").notNull(),
    workDate: date("work_date", { mode: "string" }).notNull(),
    actualMinutes: integer("actual_minutes").notNull(),
    rateMinorPerHour: numeric("rate_minor_per_hour", { precision: 20, scale: 6 }).notNull(),
    personRef: text("person_ref").notNull(),
    recordedAt: auditTimestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => [
    index("worklogs_activity_date_idx").on(
      table.tenantId,
      table.projectId,
      table.activityId,
      table.workDate,
    ),
    foreignKey({
      name: "worklogs_activity_fk",
      columns: [table.tenantId, table.projectId, table.activityId],
      foreignColumns: [activities.tenantId, activities.projectId, activities.id],
    }).onDelete("restrict"),
    check("worklogs_actual_minutes_positive", sql`${table.actualMinutes} > 0`),
    check("worklogs_rate_non_negative", sql`${table.rateMinorPerHour} >= 0`),
    check("worklogs_person_ref_not_blank", sql`length(trim(${table.personRef})) > 0`),
  ],
);

export const directActualCosts = pgTable(
  "direct_actual_costs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    activityId: uuid("activity_id").notNull(),
    costDate: date("cost_date", { mode: "string" }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    description: text().notNull(),
    recordedAt: auditTimestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => [
    index("direct_actual_costs_activity_date_idx").on(
      table.tenantId,
      table.projectId,
      table.activityId,
      table.costDate,
    ),
    foreignKey({
      name: "direct_actual_costs_activity_fk",
      columns: [table.tenantId, table.projectId, table.activityId],
      foreignColumns: [activities.tenantId, activities.projectId, activities.id],
    }).onDelete("restrict"),
    check("direct_actual_costs_amount_non_negative", sql`${table.amountMinor} >= 0`),
    check("direct_actual_costs_description_not_blank", sql`length(trim(${table.description})) > 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    sequence: bigserial({ mode: "bigint" }).primaryKey(),
    id: uuid().notNull().defaultRandom().unique(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    projectRevision: bigint("project_revision", { mode: "bigint" }).notNull(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    commandType: text("command_type").notNull(),
    payload: jsonb().notNull(),
    occurredAt: auditTimestamp("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_events_project_revision_unique").on(
      table.tenantId,
      table.projectId,
      table.projectRevision,
    ),
    foreignKey({
      name: "audit_events_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("restrict"),
    check("audit_events_revision_positive", sql`${table.projectRevision} > 0`),
    check("audit_events_actor_id_not_blank", sql`length(trim(${table.actorId})) > 0`),
    check("audit_events_command_type_not_blank", sql`length(trim(${table.commandType})) > 0`),
  ],
);

export const commandReceipts = pgTable(
  "command_receipts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    resultRevision: bigint("result_revision", { mode: "bigint" }).notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("command_receipts_project_key_unique").on(
      table.tenantId,
      table.projectId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "command_receipts_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("restrict"),
    check(
      "command_receipts_idempotency_key_length",
      sql`length(trim(${table.idempotencyKey})) between 1 and 200`,
    ),
    check("command_receipts_request_hash_hex", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("command_receipts_revision_positive", sql`${table.resultRevision} > 0`),
  ],
);

export const schema = {
  principals,
  tenants,
  tenantMemberships,
  projects,
  projectMemberships,
  wbsNodes,
  activities,
  dependencies,
  baselineVersions,
  baselineWbsNodes,
  baselineActivities,
  baselineDependencies,
  progressMeasurements,
  worklogs,
  directActualCosts,
  auditEvents,
  commandReceipts,
};
