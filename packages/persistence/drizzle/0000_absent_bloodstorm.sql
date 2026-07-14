CREATE TYPE "public"."audit_actor_type" AS ENUM('HUMAN', 'AGENT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."dependency_type" AS ENUM('FS', 'SS', 'FF', 'SF');--> statement-breakpoint
CREATE TYPE "public"."measurement_method" AS ENUM('ZERO_HUNDRED', 'PHYSICAL_PERCENT');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"wbs_node_id" uuid NOT NULL,
	"name" text NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"duration_working_days" integer NOT NULL,
	"budget_minor" bigint NOT NULL,
	"measurement_method" "measurement_method" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_tenant_project_id_unique" UNIQUE("tenant_id","project_id","id"),
	CONSTRAINT "activities_name_not_blank" CHECK (length(trim("activities"."name")) > 0),
	CONSTRAINT "activities_duration_positive" CHECK ("activities"."duration_working_days" > 0),
	CONSTRAINT "activities_budget_non_negative" CHECK ("activities"."budget_minor" >= 0),
	CONSTRAINT "activities_sort_order_non_negative" CHECK ("activities"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_revision" bigint NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"command_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_id_unique" UNIQUE("id"),
	CONSTRAINT "audit_events_revision_positive" CHECK ("audit_events"."project_revision" > 0),
	CONSTRAINT "audit_events_actor_id_not_blank" CHECK (length(trim("audit_events"."actor_id")) > 0),
	CONSTRAINT "audit_events_command_type_not_blank" CHECK (length(trim("audit_events"."command_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "baseline_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"source_activity_id" uuid NOT NULL,
	"source_wbs_node_id" uuid NOT NULL,
	"wbs_code" text NOT NULL,
	"name" text NOT NULL,
	"duration_working_days" integer NOT NULL,
	"baseline_start" date NOT NULL,
	"baseline_finish" date NOT NULL,
	"budget_minor" bigint NOT NULL,
	"measurement_method" "measurement_method" NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_activities_source_unique" UNIQUE("tenant_id","project_id","baseline_version_id","source_activity_id"),
	CONSTRAINT "baseline_activities_name_not_blank" CHECK (length(trim("baseline_activities"."name")) > 0),
	CONSTRAINT "baseline_activities_wbs_code_not_blank" CHECK (length(trim("baseline_activities"."wbs_code")) > 0),
	CONSTRAINT "baseline_activities_duration_positive" CHECK ("baseline_activities"."duration_working_days" > 0),
	CONSTRAINT "baseline_activities_budget_non_negative" CHECK ("baseline_activities"."budget_minor" >= 0),
	CONSTRAINT "baseline_activities_finish_after_start" CHECK ("baseline_activities"."baseline_finish" >= "baseline_activities"."baseline_start")
);
--> statement-breakpoint
CREATE TABLE "baseline_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"predecessor_source_activity_id" uuid NOT NULL,
	"successor_source_activity_id" uuid NOT NULL,
	"type" "dependency_type" NOT NULL,
	"lag_working_days" integer NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_dependencies_distinct_activities" CHECK ("baseline_dependencies"."predecessor_source_activity_id" <> "baseline_dependencies"."successor_source_activity_id"),
	CONSTRAINT "baseline_dependencies_lag_non_negative" CHECK ("baseline_dependencies"."lag_working_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "baseline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"label" text NOT NULL,
	"approved_at" timestamp(6) with time zone,
	"approved_by" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_versions_tenant_project_id_unique" UNIQUE("tenant_id","project_id","id"),
	CONSTRAINT "baseline_versions_version_positive" CHECK ("baseline_versions"."version" > 0),
	CONSTRAINT "baseline_versions_label_not_blank" CHECK (length(trim("baseline_versions"."label")) > 0),
	CONSTRAINT "baseline_versions_approval_complete" CHECK (("baseline_versions"."approved_at" is null and "baseline_versions"."approved_by" is null) or ("baseline_versions"."approved_at" is not null and length(trim("baseline_versions"."approved_by")) > 0))
);
--> statement-breakpoint
CREATE TABLE "baseline_wbs_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"source_wbs_node_id" uuid NOT NULL,
	"parent_source_wbs_node_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_wbs_nodes_snapshot_source_unique" UNIQUE("tenant_id","project_id","baseline_version_id","source_wbs_node_id"),
	CONSTRAINT "baseline_wbs_nodes_code_not_blank" CHECK (length(trim("baseline_wbs_nodes"."code")) > 0),
	CONSTRAINT "baseline_wbs_nodes_name_not_blank" CHECK (length(trim("baseline_wbs_nodes"."name")) > 0),
	CONSTRAINT "baseline_wbs_nodes_sort_order_non_negative" CHECK ("baseline_wbs_nodes"."sort_order" >= 0),
	CONSTRAINT "baseline_wbs_nodes_not_own_parent" CHECK ("baseline_wbs_nodes"."parent_source_wbs_node_id" is null or "baseline_wbs_nodes"."parent_source_wbs_node_id" <> "baseline_wbs_nodes"."source_wbs_node_id")
);
--> statement-breakpoint
CREATE TABLE "dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"predecessor_activity_id" uuid NOT NULL,
	"successor_activity_id" uuid NOT NULL,
	"type" "dependency_type" DEFAULT 'FS' NOT NULL,
	"lag_working_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dependencies_distinct_activities" CHECK ("dependencies"."predecessor_activity_id" <> "dependencies"."successor_activity_id"),
	CONSTRAINT "dependencies_lag_non_negative" CHECK ("dependencies"."lag_working_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "direct_actual_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"cost_date" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"description" text NOT NULL,
	"recorded_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_actual_costs_amount_non_negative" CHECK ("direct_actual_costs"."amount_minor" >= 0),
	CONSTRAINT "direct_actual_costs_description_not_blank" CHECK (length(trim("direct_actual_costs"."description")) > 0)
);
--> statement-breakpoint
CREATE TABLE "progress_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"measurement_date" date NOT NULL,
	"method" "measurement_method" NOT NULL,
	"progress_basis_points" integer NOT NULL,
	"recorded_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progress_measurements_activity_date_unique" UNIQUE("tenant_id","project_id","activity_id","measurement_date"),
	CONSTRAINT "progress_measurements_range" CHECK ("progress_measurements"."progress_basis_points" between 0 and 10000),
	CONSTRAINT "progress_measurements_zero_hundred_values" CHECK ("progress_measurements"."method" <> 'ZERO_HUNDRED' or "progress_measurements"."progress_basis_points" in (0, 10000))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) DEFAULT 'JPY' NOT NULL,
	"timezone" text DEFAULT 'Asia/Tokyo' NOT NULL,
	"project_start" date NOT NULL,
	"status_date" date NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "projects_name_not_blank" CHECK (length(trim("projects"."name")) > 0),
	CONSTRAINT "projects_currency_uppercase" CHECK ("projects"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "projects_revision_non_negative" CHECK ("projects"."revision" >= 0),
	CONSTRAINT "projects_status_after_start" CHECK ("projects"."status_date" >= "projects"."project_start")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wbs_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wbs_nodes_tenant_project_id_unique" UNIQUE("tenant_id","project_id","id"),
	CONSTRAINT "wbs_nodes_code_not_blank" CHECK (length(trim("wbs_nodes"."code")) > 0),
	CONSTRAINT "wbs_nodes_name_not_blank" CHECK (length(trim("wbs_nodes"."name")) > 0),
	CONSTRAINT "wbs_nodes_sort_order_non_negative" CHECK ("wbs_nodes"."sort_order" >= 0),
	CONSTRAINT "wbs_nodes_not_own_parent" CHECK ("wbs_nodes"."parent_id" is null or "wbs_nodes"."parent_id" <> "wbs_nodes"."id")
);
--> statement-breakpoint
CREATE TABLE "worklogs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"actual_minutes" integer NOT NULL,
	"rate_minor_per_hour" numeric(20, 6) NOT NULL,
	"person_ref" text NOT NULL,
	"recorded_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worklogs_actual_minutes_positive" CHECK ("worklogs"."actual_minutes" > 0),
	CONSTRAINT "worklogs_rate_non_negative" CHECK ("worklogs"."rate_minor_per_hour" >= 0),
	CONSTRAINT "worklogs_person_ref_not_blank" CHECK (length(trim("worklogs"."person_ref")) > 0)
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_wbs_node_fk" FOREIGN KEY ("tenant_id","project_id","wbs_node_id") REFERENCES "public"."wbs_nodes"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_activities" ADD CONSTRAINT "baseline_activities_version_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id") REFERENCES "public"."baseline_versions"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_activities" ADD CONSTRAINT "baseline_activities_wbs_node_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","source_wbs_node_id") REFERENCES "public"."baseline_wbs_nodes"("tenant_id","project_id","baseline_version_id","source_wbs_node_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_dependencies" ADD CONSTRAINT "baseline_dependencies_predecessor_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","predecessor_source_activity_id") REFERENCES "public"."baseline_activities"("tenant_id","project_id","baseline_version_id","source_activity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_dependencies" ADD CONSTRAINT "baseline_dependencies_successor_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","successor_source_activity_id") REFERENCES "public"."baseline_activities"("tenant_id","project_id","baseline_version_id","source_activity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_versions" ADD CONSTRAINT "baseline_versions_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_wbs_nodes" ADD CONSTRAINT "baseline_wbs_nodes_version_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id") REFERENCES "public"."baseline_versions"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_wbs_nodes" ADD CONSTRAINT "baseline_wbs_nodes_parent_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","parent_source_wbs_node_id") REFERENCES "public"."baseline_wbs_nodes"("tenant_id","project_id","baseline_version_id","source_wbs_node_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_predecessor_fk" FOREIGN KEY ("tenant_id","project_id","predecessor_activity_id") REFERENCES "public"."activities"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_successor_fk" FOREIGN KEY ("tenant_id","project_id","successor_activity_id") REFERENCES "public"."activities"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_actual_costs" ADD CONSTRAINT "direct_actual_costs_activity_fk" FOREIGN KEY ("tenant_id","project_id","activity_id") REFERENCES "public"."activities"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_measurements" ADD CONSTRAINT "progress_measurements_activity_fk" FOREIGN KEY ("tenant_id","project_id","activity_id") REFERENCES "public"."activities"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_parent_fk" FOREIGN KEY ("tenant_id","project_id","parent_id") REFERENCES "public"."wbs_nodes"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_activity_fk" FOREIGN KEY ("tenant_id","project_id","activity_id") REFERENCES "public"."activities"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_wbs_node_idx" ON "activities" USING btree ("tenant_id","project_id","wbs_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_project_revision_unique" ON "audit_events" USING btree ("tenant_id","project_id","project_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "baseline_dependencies_edge_unique" ON "baseline_dependencies" USING btree ("tenant_id","project_id","baseline_version_id","predecessor_source_activity_id","successor_source_activity_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "baseline_versions_project_version_unique" ON "baseline_versions" USING btree ("tenant_id","project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "dependencies_edge_unique" ON "dependencies" USING btree ("tenant_id","project_id","predecessor_activity_id","successor_activity_id","type");--> statement-breakpoint
CREATE INDEX "dependencies_successor_idx" ON "dependencies" USING btree ("tenant_id","project_id","successor_activity_id");--> statement-breakpoint
CREATE INDEX "direct_actual_costs_activity_date_idx" ON "direct_actual_costs" USING btree ("tenant_id","project_id","activity_id","cost_date");--> statement-breakpoint
CREATE INDEX "projects_tenant_id_idx" ON "projects" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wbs_nodes_project_code_unique" ON "wbs_nodes" USING btree ("tenant_id","project_id","code");--> statement-breakpoint
CREATE INDEX "wbs_nodes_parent_idx" ON "wbs_nodes" USING btree ("tenant_id","project_id","parent_id");--> statement-breakpoint
CREATE INDEX "worklogs_activity_date_idx" ON "worklogs" USING btree ("tenant_id","project_id","activity_id","work_date");