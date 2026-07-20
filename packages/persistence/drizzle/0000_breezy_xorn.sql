CREATE TYPE "public"."audit_actor_type" AS ENUM('HUMAN', 'AGENT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."dependency_type" AS ENUM('FS', 'SS', 'FF', 'SF');--> statement-breakpoint
CREATE TYPE "public"."principal_type" AS ENUM('HUMAN', 'AGENT');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('OWNER', 'EDITOR', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."tenant_role" AS ENUM('OWNER', 'ADMIN', 'MEMBER');--> statement-breakpoint
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
CREATE TABLE "command_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" char(64) NOT NULL,
	"result_revision" bigint NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_receipts_project_key_unique" UNIQUE("tenant_id","project_id","idempotency_key"),
	CONSTRAINT "command_receipts_idempotency_key_length" CHECK (length(trim("command_receipts"."idempotency_key")) between 1 and 200),
	CONSTRAINT "command_receipts_request_hash_hex" CHECK ("command_receipts"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "command_receipts_revision_positive" CHECK ("command_receipts"."result_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"calendar_id" text NOT NULL,
	"daily_capacity_minutes" integer NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "members_name_not_blank" CHECK (length(trim("members"."name")) > 0),
	CONSTRAINT "members_daily_capacity_range" CHECK ("members"."daily_capacity_minutes" between 1 and 1440)
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"type" "principal_type" NOT NULL,
	"display_name" text NOT NULL,
	"allowed_scopes" text[] DEFAULT array[]::text[] NOT NULL,
	"disabled_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_issuer_not_blank" CHECK (length(trim("principals"."issuer")) > 0),
	CONSTRAINT "principals_subject_not_blank" CHECK (length(trim("principals"."subject")) > 0),
	CONSTRAINT "principals_display_name_not_blank" CHECK (length(trim("principals"."display_name")) > 0),
	CONSTRAINT "principals_allowed_scopes_known" CHECK ("principals"."allowed_scopes" <@ array['project:progress:write', 'project:actuals:write']::text[]),
	CONSTRAINT "principals_human_scopes_empty" CHECK ("principals"."type" <> 'HUMAN' or cardinality("principals"."allowed_scopes") = 0)
);
--> statement-breakpoint
CREATE TABLE "project_calendars" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"working_weekdays" integer[] NOT NULL,
	"non_working_dates" date[] NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_calendars_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "project_calendars_id_not_blank" CHECK (length(trim("project_calendars"."id")) > 0),
	CONSTRAINT "project_calendars_name_not_blank" CHECK (length(trim("project_calendars"."name")) > 0),
	CONSTRAINT "project_calendars_working_weekdays_known" CHECK (cardinality("project_calendars"."working_weekdays") > 0 and "project_calendars"."working_weekdays" <@ array[1,2,3,4,5,6,7]::integer[])
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" "project_role" NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_tenant_id_project_id_principal_id_pk" PRIMARY KEY("tenant_id","project_id","principal_id")
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
	"default_calendar_id" text DEFAULT 'standard' NOT NULL,
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
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"predecessor_task_id" uuid NOT NULL,
	"successor_task_id" uuid NOT NULL,
	"type" "dependency_type" DEFAULT 'FS' NOT NULL,
	"lag_working_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_distinct_tasks" CHECK ("task_dependencies"."predecessor_task_id" <> "task_dependencies"."successor_task_id"),
	CONSTRAINT "task_dependencies_lag_non_negative" CHECK ("task_dependencies"."lag_working_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"process" text DEFAULT '' NOT NULL,
	"product" text DEFAULT '' NOT NULL,
	"review_ref" text DEFAULT '' NOT NULL,
	"change_ref" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"contract" text DEFAULT '' NOT NULL,
	"assignee_member_id" uuid,
	"planned_effort_minutes" integer DEFAULT 0 NOT NULL,
	"progress_basis_points" integer DEFAULT 0 NOT NULL,
	"actual_effort_minutes" integer DEFAULT 0 NOT NULL,
	"daily_plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"daily_plan_locked" boolean DEFAULT false NOT NULL,
	"actual_start" date,
	"actual_finish" date,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_tenant_project_id_unique" UNIQUE("tenant_id","project_id","id"),
	CONSTRAINT "tasks_name_not_blank" CHECK (length(trim("tasks"."name")) > 0),
	CONSTRAINT "tasks_sort_order_non_negative" CHECK ("tasks"."sort_order" >= 0),
	CONSTRAINT "tasks_planned_effort_non_negative" CHECK ("tasks"."planned_effort_minutes" >= 0),
	CONSTRAINT "tasks_actual_effort_non_negative" CHECK ("tasks"."actual_effort_minutes" >= 0),
	CONSTRAINT "tasks_progress_range" CHECK ("tasks"."progress_basis_points" between 0 and 10000),
	CONSTRAINT "tasks_not_own_parent" CHECK ("tasks"."parent_task_id" is null or "tasks"."parent_task_id" <> "tasks"."id"),
	CONSTRAINT "tasks_actual_dates_ordered" CHECK ("tasks"."actual_start" is null or "tasks"."actual_finish" is null or "tasks"."actual_finish" >= "tasks"."actual_start")
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" "tenant_role" NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_tenant_id_principal_id_pk" PRIMARY KEY("tenant_id","principal_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_calendar_fk" FOREIGN KEY ("tenant_id","project_id","calendar_id") REFERENCES "public"."project_calendars"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calendars" ADD CONSTRAINT "project_calendars_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_tenant_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."tenant_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_predecessor_fk" FOREIGN KEY ("tenant_id","project_id","predecessor_task_id") REFERENCES "public"."tasks"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_successor_fk" FOREIGN KEY ("tenant_id","project_id","successor_task_id") REFERENCES "public"."tasks"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_fk" FOREIGN KEY ("tenant_id","project_id","parent_task_id") REFERENCES "public"."tasks"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_fk" FOREIGN KEY ("tenant_id","project_id","assignee_member_id") REFERENCES "public"."members"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_project_revision_unique" ON "audit_events" USING btree ("tenant_id","project_id","project_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_issuer_subject_unique" ON "principals" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "project_memberships_principal_idx" ON "project_memberships" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "projects_tenant_id_idx" ON "projects" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_edge_unique" ON "task_dependencies" USING btree ("tenant_id","project_id","predecessor_task_id","successor_task_id","type");--> statement-breakpoint
CREATE INDEX "task_dependencies_successor_idx" ON "task_dependencies" USING btree ("tenant_id","project_id","successor_task_id");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("tenant_id","project_id","parent_task_id");--> statement-breakpoint
CREATE INDEX "tasks_sort_order_idx" ON "tasks" USING btree ("tenant_id","project_id","sort_order");--> statement-breakpoint
CREATE INDEX "tenant_memberships_principal_idx" ON "tenant_memberships" USING btree ("principal_id");--> statement-breakpoint
CREATE FUNCTION reject_immutable_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% records are immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();--> statement-breakpoint
CREATE TRIGGER command_receipts_immutable
BEFORE UPDATE OR DELETE ON command_receipts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();