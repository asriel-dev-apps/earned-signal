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
export const scheduleConstraintType = pgEnum("schedule_constraint_type", [
  "START_NO_EARLIER_THAN",
  "FINISH_NO_LATER_THAN",
  "MUST_START_ON",
  "MUST_FINISH_ON",
]);

export const auditActorType = pgEnum("audit_actor_type", ["HUMAN", "AGENT", "SYSTEM"]);
export const principalType = pgEnum("principal_type", ["HUMAN", "AGENT"]);
export const tenantRole = pgEnum("tenant_role", ["OWNER", "ADMIN", "MEMBER"]);
export const projectRole = pgEnum("project_role", ["OWNER", "EDITOR", "VIEWER"]);
export const scenarioStatus = pgEnum("scenario_status", ["DRAFT", "PUBLISHED", "DISCARDED"]);
export const staffingProposalStatus = pgEnum("staffing_proposal_status", [
  "REQUESTED",
  "RUNNING",
  "READY",
  "INFEASIBLE",
  "UNKNOWN",
  "FAILED",
]);

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
      sql`${table.allowedScopes} <@ array['project:progress:write', 'project:actuals:write', 'project:staffing:propose']::text[]`,
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
    defaultCalendarId: text("default_calendar_id").notNull().default("standard"),
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

export const projectCalendars = pgTable(
  "project_calendars",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    id: text().notNull(),
    name: text().notNull(),
    workingWeekdays: integer("working_weekdays").array().notNull(),
    nonWorkingDates: date("non_working_dates", { mode: "string" }).array().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    foreignKey({
      name: "project_calendars_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    check("project_calendars_id_not_blank", sql`length(trim(${table.id})) > 0`),
    check("project_calendars_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check(
      "project_calendars_working_weekdays_known",
      sql`cardinality(${table.workingWeekdays}) > 0 and ${table.workingWeekdays} <@ array[1,2,3,4,5,6,7]::integer[]`,
    ),
  ],
);

export const skills = pgTable(
  "skills",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    foreignKey({
      name: "skills_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    check("skills_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

export const resources = pgTable(
  "resources",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text().notNull(),
    calendarId: text("calendar_id").notNull(),
    dailyCapacityMinutes: integer("daily_capacity_minutes").notNull(),
    costRateMinorPerHour: bigint("cost_rate_minor_per_hour", { mode: "bigint" }).notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    foreignKey({
      name: "resources_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "resources_calendar_fk",
      columns: [table.tenantId, table.projectId, table.calendarId],
      foreignColumns: [projectCalendars.tenantId, projectCalendars.projectId, projectCalendars.id],
    }).onDelete("restrict"),
    check("resources_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check(
      "resources_daily_capacity_range",
      sql`${table.dailyCapacityMinutes} between 1 and 1440`,
    ),
    check("resources_cost_rate_non_negative", sql`${table.costRateMinorPerHour} >= 0`),
  ],
);

export const resourceSkills = pgTable(
  "resource_skills",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.resourceId, table.skillId] }),
    foreignKey({
      name: "resource_skills_resource_fk",
      columns: [table.tenantId, table.projectId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.projectId, resources.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "resource_skills_skill_fk",
      columns: [table.tenantId, table.projectId, table.skillId],
      foreignColumns: [skills.tenantId, skills.projectId, skills.id],
    }).onDelete("restrict"),
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
    calendarId: text("calendar_id").notNull().default("standard"),
    constraintType: scheduleConstraintType("constraint_type"),
    constraintDate: date("constraint_date", { mode: "string" }),
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
    foreignKey({
      name: "activities_calendar_fk",
      columns: [table.tenantId, table.projectId, table.calendarId],
      foreignColumns: [projectCalendars.tenantId, projectCalendars.projectId, projectCalendars.id],
    }).onDelete("restrict"),
    check("activities_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("activities_duration_positive", sql`${table.durationWorkingDays} > 0`),
    check("activities_budget_non_negative", sql`${table.budgetMinor} >= 0`),
    check("activities_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
    check(
      "activities_constraint_complete",
      sql`(${table.constraintType} is null) = (${table.constraintDate} is null)`,
    ),
  ],
);

export const activitySkillRequirements = pgTable(
  "activity_skill_requirements",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    activityId: uuid("activity_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.activityId, table.skillId] }),
    foreignKey({
      name: "activity_skill_requirements_activity_fk",
      columns: [table.tenantId, table.projectId, table.activityId],
      foreignColumns: [activities.tenantId, activities.projectId, activities.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "activity_skill_requirements_skill_fk",
      columns: [table.tenantId, table.projectId, table.skillId],
      foreignColumns: [skills.tenantId, skills.projectId, skills.id],
    }).onDelete("restrict"),
  ],
);

export const assignments = pgTable(
  "assignments",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    activityId: uuid("activity_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    unitsPercent: integer("units_percent").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.activityId, table.resourceId] }),
    index("assignments_resource_idx").on(table.tenantId, table.projectId, table.resourceId),
    foreignKey({
      name: "assignments_activity_fk",
      columns: [table.tenantId, table.projectId, table.activityId],
      foreignColumns: [activities.tenantId, activities.projectId, activities.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "assignments_resource_fk",
      columns: [table.tenantId, table.projectId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.projectId, resources.id],
    }).onDelete("restrict"),
    check("assignments_units_range", sql`${table.unitsPercent} between 1 and 100`),
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
    defaultCalendarId: text("default_calendar_id").notNull().default("standard"),
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

export const baselineCalendars = pgTable(
  "baseline_calendars",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    sourceCalendarId: text("source_calendar_id").notNull(),
    name: text().notNull(),
    workingWeekdays: integer("working_weekdays").array().notNull(),
    nonWorkingDates: date("non_working_dates", { mode: "string" }).array().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.projectId,
        table.baselineVersionId,
        table.sourceCalendarId,
      ],
    }),
    foreignKey({
      name: "baseline_calendars_version_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId],
      foreignColumns: [
        baselineVersions.tenantId,
        baselineVersions.projectId,
        baselineVersions.id,
      ],
    }).onDelete("restrict"),
    check("baseline_calendars_id_not_blank", sql`length(trim(${table.sourceCalendarId})) > 0`),
    check("baseline_calendars_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check(
      "baseline_calendars_working_weekdays_known",
      sql`cardinality(${table.workingWeekdays}) > 0 and ${table.workingWeekdays} <@ array[1,2,3,4,5,6,7]::integer[]`,
    ),
  ],
);

export const baselineSkills = pgTable(
  "baseline_skills",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    sourceSkillId: uuid("source_skill_id").notNull(),
    name: text().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceSkillId],
    }),
    foreignKey({
      name: "baseline_skills_version_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId],
      foreignColumns: [baselineVersions.tenantId, baselineVersions.projectId, baselineVersions.id],
    }).onDelete("restrict"),
    check("baseline_skills_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

export const baselineResources = pgTable(
  "baseline_resources",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    sourceResourceId: uuid("source_resource_id").notNull(),
    name: text().notNull(),
    calendarId: text("calendar_id").notNull(),
    dailyCapacityMinutes: integer("daily_capacity_minutes").notNull(),
    costRateMinorPerHour: bigint("cost_rate_minor_per_hour", { mode: "bigint" }).notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceResourceId],
    }),
    foreignKey({
      name: "baseline_resources_version_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId],
      foreignColumns: [baselineVersions.tenantId, baselineVersions.projectId, baselineVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "baseline_resources_calendar_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.calendarId],
      foreignColumns: [baselineCalendars.tenantId, baselineCalendars.projectId, baselineCalendars.baselineVersionId, baselineCalendars.sourceCalendarId],
    }).onDelete("restrict"),
    check("baseline_resources_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("baseline_resources_daily_capacity_range", sql`${table.dailyCapacityMinutes} between 1 and 1440`),
    check("baseline_resources_cost_rate_non_negative", sql`${table.costRateMinorPerHour} >= 0`),
  ],
);

export const baselineResourceSkills = pgTable(
  "baseline_resource_skills",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    sourceResourceId: uuid("source_resource_id").notNull(),
    sourceSkillId: uuid("source_skill_id").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceResourceId, table.sourceSkillId],
    }),
    foreignKey({
      name: "baseline_resource_skills_resource_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceResourceId],
      foreignColumns: [baselineResources.tenantId, baselineResources.projectId, baselineResources.baselineVersionId, baselineResources.sourceResourceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "baseline_resource_skills_skill_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceSkillId],
      foreignColumns: [baselineSkills.tenantId, baselineSkills.projectId, baselineSkills.baselineVersionId, baselineSkills.sourceSkillId],
    }).onDelete("restrict"),
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
    owner: text().notNull().default(""),
    durationWorkingDays: integer("duration_working_days").notNull(),
    calendarId: text("calendar_id").notNull().default("standard"),
    constraintType: scheduleConstraintType("constraint_type"),
    constraintDate: date("constraint_date", { mode: "string" }),
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
      name: "baseline_activities_calendar_fk",
      columns: [
        table.tenantId,
        table.projectId,
        table.baselineVersionId,
        table.calendarId,
      ],
      foreignColumns: [
        baselineCalendars.tenantId,
        baselineCalendars.projectId,
        baselineCalendars.baselineVersionId,
        baselineCalendars.sourceCalendarId,
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
    check(
      "baseline_activities_constraint_complete",
      sql`(${table.constraintType} is null) = (${table.constraintDate} is null)`,
    ),
  ],
);

export const baselineActivitySkillRequirements = pgTable(
  "baseline_activity_skill_requirements",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    sourceActivityId: uuid("source_activity_id").notNull(),
    sourceSkillId: uuid("source_skill_id").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceActivityId, table.sourceSkillId],
    }),
    foreignKey({
      name: "baseline_activity_skill_requirements_activity_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceActivityId],
      foreignColumns: [baselineActivities.tenantId, baselineActivities.projectId, baselineActivities.baselineVersionId, baselineActivities.sourceActivityId],
    }).onDelete("restrict"),
    foreignKey({
      name: "baseline_activity_skill_requirements_skill_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceSkillId],
      foreignColumns: [baselineSkills.tenantId, baselineSkills.projectId, baselineSkills.baselineVersionId, baselineSkills.sourceSkillId],
    }).onDelete("restrict"),
  ],
);

export const baselineAssignments = pgTable(
  "baseline_assignments",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    sourceActivityId: uuid("source_activity_id").notNull(),
    sourceResourceId: uuid("source_resource_id").notNull(),
    unitsPercent: integer("units_percent").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceActivityId, table.sourceResourceId],
    }),
    index("baseline_assignments_resource_idx").on(table.tenantId, table.projectId, table.baselineVersionId, table.sourceResourceId),
    foreignKey({
      name: "baseline_assignments_activity_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceActivityId],
      foreignColumns: [baselineActivities.tenantId, baselineActivities.projectId, baselineActivities.baselineVersionId, baselineActivities.sourceActivityId],
    }).onDelete("restrict"),
    foreignKey({
      name: "baseline_assignments_resource_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId, table.sourceResourceId],
      foreignColumns: [baselineResources.tenantId, baselineResources.projectId, baselineResources.baselineVersionId, baselineResources.sourceResourceId],
    }).onDelete("restrict"),
    check("baseline_assignments_units_range", sql`${table.unitsPercent} between 1 and 100`),
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

export const periodBuckets = pgTable(
  "period_buckets",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    statusDate: date("status_date", { mode: "string" }).notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.statusDate] }),
    foreignKey({
      name: "period_buckets_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    check("period_buckets_dates_ordered", sql`${table.periodStart} <= ${table.statusDate} and ${table.statusDate} <= ${table.periodEnd}`),
  ],
);

export const evmSnapshots = pgTable(
  "evm_snapshots",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    statusDate: date("status_date", { mode: "string" }).notNull(),
    baselineVersionId: uuid("baseline_version_id").notNull(),
    bac: numeric({ precision: 20, scale: 2 }).notNull(),
    pv: numeric({ precision: 20, scale: 2 }).notNull(),
    ev: numeric({ precision: 20, scale: 2 }).notNull(),
    ac: numeric({ precision: 20, scale: 2 }).notNull(),
    sv: numeric({ precision: 20, scale: 2 }).notNull(),
    cv: numeric({ precision: 20, scale: 2 }).notNull(),
    spi: numeric({ precision: 20, scale: 4 }),
    cpi: numeric({ precision: 20, scale: 4 }),
    eac: numeric({ precision: 20, scale: 2 }),
    etc: numeric({ precision: 20, scale: 2 }),
    vac: numeric({ precision: 20, scale: 2 }),
    tcpi: numeric({ precision: 20, scale: 4 }),
    calculatedAt: auditTimestamp("calculated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.statusDate] }),
    foreignKey({
      name: "evm_snapshots_period_bucket_fk",
      columns: [table.tenantId, table.projectId, table.statusDate],
      foreignColumns: [periodBuckets.tenantId, periodBuckets.projectId, periodBuckets.statusDate],
    }).onDelete("cascade"),
    foreignKey({
      name: "evm_snapshots_baseline_version_fk",
      columns: [table.tenantId, table.projectId, table.baselineVersionId],
      foreignColumns: [baselineVersions.tenantId, baselineVersions.projectId, baselineVersions.id],
    }).onDelete("restrict"),
    check("evm_snapshots_non_negative_totals", sql`${table.bac} >= 0 and ${table.pv} >= 0 and ${table.ev} >= 0 and ${table.ac} >= 0`),
  ],
);

export const evmSnapshotWbsVariances = pgTable(
  "evm_snapshot_wbs_variances",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    statusDate: date("status_date", { mode: "string" }).notNull(),
    activityId: uuid("activity_id").notNull(),
    wbs: text().notNull(),
    rank: integer().notNull(),
    pv: numeric({ precision: 20, scale: 2 }).notNull(),
    ev: numeric({ precision: 20, scale: 2 }).notNull(),
    ac: numeric({ precision: 20, scale: 2 }).notNull(),
    sv: numeric({ precision: 20, scale: 2 }).notNull(),
    cv: numeric({ precision: 20, scale: 2 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.statusDate, table.activityId] }),
    unique("evm_snapshot_wbs_variances_rank_unique").on(
      table.tenantId,
      table.projectId,
      table.statusDate,
      table.rank,
    ),
    foreignKey({
      name: "evm_snapshot_wbs_variances_snapshot_fk",
      columns: [table.tenantId, table.projectId, table.statusDate],
      foreignColumns: [evmSnapshots.tenantId, evmSnapshots.projectId, evmSnapshots.statusDate],
    }).onDelete("cascade"),
    check("evm_snapshot_wbs_variances_wbs_not_blank", sql`length(trim(${table.wbs})) > 0`),
    check("evm_snapshot_wbs_variances_rank_positive", sql`${table.rank} > 0`),
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

export const scenarios = pgTable(
  "scenarios",
  {
    id: uuid().notNull().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text().notNull(),
    status: scenarioStatus().notNull().default("DRAFT"),
    baseProjectRevision: bigint("base_project_revision", { mode: "bigint" }).notNull(),
    revision: bigint({ mode: "bigint" }).notNull().default(sql`1`),
    changes: jsonb().notNull().default(sql`'[]'::jsonb`),
    latestRunId: uuid("latest_run_id"),
    createdBy: text("created_by").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
    publishedBy: text("published_by"),
    publishedAt: auditTimestamp("published_at"),
    discardedBy: text("discarded_by"),
    discardedAt: auditTimestamp("discarded_at"),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    unique("scenarios_id_unique").on(table.id),
    index("scenarios_project_status_idx").on(table.tenantId, table.projectId, table.status),
    foreignKey({
      name: "scenarios_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("restrict"),
    check("scenarios_name_length", sql`length(trim(${table.name})) between 1 and 200`),
    check("scenarios_base_revision_non_negative", sql`${table.baseProjectRevision} >= 0`),
    check("scenarios_revision_positive", sql`${table.revision} > 0`),
    check("scenarios_created_by_not_blank", sql`length(trim(${table.createdBy})) > 0`),
    check("scenarios_updated_by_not_blank", sql`length(trim(${table.updatedBy})) > 0`),
    check(
      "scenarios_terminal_metadata_consistent",
      sql`(
        ${table.status} = 'DRAFT' and ${table.publishedAt} is null and ${table.publishedBy} is null and ${table.discardedAt} is null and ${table.discardedBy} is null
      ) or (
        ${table.status} = 'PUBLISHED' and ${table.latestRunId} is not null and ${table.publishedAt} is not null and length(trim(${table.publishedBy})) > 0 and ${table.discardedAt} is null and ${table.discardedBy} is null
      ) or (
        ${table.status} = 'DISCARDED' and ${table.discardedAt} is not null and length(trim(${table.discardedBy})) > 0 and ${table.publishedAt} is null and ${table.publishedBy} is null
      )`,
    ),
  ],
);

export const scenarioRuns = pgTable(
  "scenario_runs",
  {
    id: uuid().notNull().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    scenarioId: uuid("scenario_id").notNull(),
    sourceProjectRevision: bigint("source_project_revision", { mode: "bigint" }).notNull(),
    sourceScenarioRevision: bigint("source_scenario_revision", { mode: "bigint" }).notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    inputHash: char("input_hash", { length: 64 }).notNull(),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    output: jsonb().notNull(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.scenarioId, table.id] }),
    unique("scenario_runs_id_unique").on(table.id),
    index("scenario_runs_scenario_created_idx").on(
      table.tenantId,
      table.projectId,
      table.scenarioId,
      table.createdAt,
    ),
    foreignKey({
      name: "scenario_runs_scenario_fk",
      columns: [table.tenantId, table.projectId, table.scenarioId],
      foreignColumns: [scenarios.tenantId, scenarios.projectId, scenarios.id],
    }).onDelete("restrict"),
    check("scenario_runs_project_revision_non_negative", sql`${table.sourceProjectRevision} >= 0`),
    check("scenario_runs_scenario_revision_positive", sql`${table.sourceScenarioRevision} > 0`),
    check("scenario_runs_algorithm_version_not_blank", sql`length(trim(${table.algorithmVersion})) between 1 and 100`),
    check("scenario_runs_input_hash_hex", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("scenario_runs_actor_id_not_blank", sql`length(trim(${table.actorId})) > 0`),
  ],
);

export const scenarioAuditEvents = pgTable(
  "scenario_audit_events",
  {
    sequence: bigserial({ mode: "bigint" }).primaryKey(),
    id: uuid().notNull().defaultRandom().unique(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    scenarioId: uuid("scenario_id").notNull(),
    scenarioRevision: bigint("scenario_revision", { mode: "bigint" }).notNull(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb().notNull(),
    occurredAt: auditTimestamp("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    index("scenario_audit_events_scenario_sequence_idx").on(
      table.tenantId,
      table.projectId,
      table.scenarioId,
      table.sequence,
    ),
    foreignKey({
      name: "scenario_audit_events_scenario_fk",
      columns: [table.tenantId, table.projectId, table.scenarioId],
      foreignColumns: [scenarios.tenantId, scenarios.projectId, scenarios.id],
    }).onDelete("restrict"),
    check("scenario_audit_events_revision_positive", sql`${table.scenarioRevision} > 0`),
    check("scenario_audit_events_actor_id_not_blank", sql`length(trim(${table.actorId})) > 0`),
    check("scenario_audit_events_event_type_not_blank", sql`length(trim(${table.eventType})) > 0`),
  ],
);

export const staffingProposals = pgTable(
  "staffing_proposals",
  {
    id: uuid().notNull().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text().notNull(),
    status: staffingProposalStatus().notNull().default("REQUESTED"),
    baseProjectRevision: bigint("base_project_revision", { mode: "bigint" }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    input: jsonb().notNull(),
    latestRunId: uuid("latest_run_id"),
    linkedScenarioId: uuid("linked_scenario_id"),
    createdByType: auditActorType("created_by_type").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
    startedAt: auditTimestamp("started_at"),
    completedAt: auditTimestamp("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    unique("staffing_proposals_id_unique").on(table.id),
    unique("staffing_proposals_project_idempotency_unique").on(
      table.tenantId,
      table.projectId,
      table.idempotencyKey,
    ),
    index("staffing_proposals_project_status_idx").on(
      table.tenantId,
      table.projectId,
      table.status,
      table.createdAt,
    ),
    foreignKey({
      name: "staffing_proposals_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "staffing_proposals_linked_scenario_fk",
      columns: [table.tenantId, table.projectId, table.linkedScenarioId],
      foreignColumns: [scenarios.tenantId, scenarios.projectId, scenarios.id],
    }).onDelete("restrict"),
    check("staffing_proposals_name_length", sql`length(trim(${table.name})) between 1 and 200`),
    check("staffing_proposals_base_revision_non_negative", sql`${table.baseProjectRevision} >= 0`),
    check(
      "staffing_proposals_idempotency_key_length",
      sql`length(trim(${table.idempotencyKey})) between 1 and 200`,
    ),
    check("staffing_proposals_request_hash_hex", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("staffing_proposals_created_by_not_blank", sql`length(trim(${table.createdBy})) > 0`),
    check(
      "staffing_proposals_status_metadata_consistent",
      sql`(
        ${table.status} = 'REQUESTED' and ${table.startedAt} is null and ${table.completedAt} is null and ${table.latestRunId} is null
      ) or (
        ${table.status} = 'RUNNING' and ${table.startedAt} is not null and ${table.completedAt} is null and ${table.latestRunId} is null
      ) or (
        ${table.status} in ('READY', 'INFEASIBLE', 'UNKNOWN', 'FAILED') and ${table.completedAt} is not null and ${table.latestRunId} is not null
      )`,
    ),
    check(
      "staffing_proposals_scenario_requires_ready",
      sql`${table.linkedScenarioId} is null or ${table.status} = 'READY'`,
    ),
  ],
);

export const staffingProposalRuns = pgTable(
  "staffing_proposal_runs",
  {
    id: uuid().notNull().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    status: staffingProposalStatus().notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    output: jsonb().notNull(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.proposalId, table.id] }),
    unique("staffing_proposal_runs_id_unique").on(table.id),
    index("staffing_proposal_runs_proposal_created_idx").on(
      table.tenantId,
      table.projectId,
      table.proposalId,
      table.createdAt,
    ),
    foreignKey({
      name: "staffing_proposal_runs_proposal_fk",
      columns: [table.tenantId, table.projectId, table.proposalId],
      foreignColumns: [staffingProposals.tenantId, staffingProposals.projectId, staffingProposals.id],
    }).onDelete("restrict"),
    check(
      "staffing_proposal_runs_terminal_status",
      sql`${table.status} in ('READY', 'INFEASIBLE', 'UNKNOWN', 'FAILED')`,
    ),
    check(
      "staffing_proposal_runs_algorithm_version_not_blank",
      sql`length(trim(${table.algorithmVersion})) between 1 and 100`,
    ),
    check("staffing_proposal_runs_actor_id_not_blank", sql`length(trim(${table.actorId})) > 0`),
  ],
);

export const staffingProposalAuditEvents = pgTable(
  "staffing_proposal_audit_events",
  {
    sequence: bigserial({ mode: "bigint" }).primaryKey(),
    id: uuid().notNull().defaultRandom().unique(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb().notNull(),
    occurredAt: auditTimestamp("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    index("staffing_proposal_audit_events_proposal_sequence_idx").on(
      table.tenantId,
      table.projectId,
      table.proposalId,
      table.sequence,
    ),
    foreignKey({
      name: "staffing_proposal_audit_events_proposal_fk",
      columns: [table.tenantId, table.projectId, table.proposalId],
      foreignColumns: [staffingProposals.tenantId, staffingProposals.projectId, staffingProposals.id],
    }).onDelete("restrict"),
    check("staffing_proposal_audit_events_actor_id_not_blank", sql`length(trim(${table.actorId})) > 0`),
    check("staffing_proposal_audit_events_event_type_not_blank", sql`length(trim(${table.eventType})) > 0`),
  ],
);

export const schema = {
  principals,
  tenants,
  tenantMemberships,
  projects,
  projectCalendars,
  skills,
  resources,
  resourceSkills,
  projectMemberships,
  wbsNodes,
  activities,
  activitySkillRequirements,
  assignments,
  dependencies,
  baselineVersions,
  baselineCalendars,
  baselineWbsNodes,
  baselineActivities,
  baselineDependencies,
  periodBuckets,
  evmSnapshots,
  evmSnapshotWbsVariances,
  progressMeasurements,
  worklogs,
  directActualCosts,
  auditEvents,
  commandReceipts,
  scenarios,
  scenarioRuns,
  scenarioAuditEvents,
  staffingProposals,
  staffingProposalRuns,
  staffingProposalAuditEvents,
};
