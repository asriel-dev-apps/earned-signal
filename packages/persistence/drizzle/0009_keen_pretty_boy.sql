CREATE TABLE "baseline_activity_skill_requirements" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"source_activity_id" uuid NOT NULL,
	"source_skill_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_activity_skill_requirements_tenant_id_project_id_baseline_version_id_source_activity_id_source_skill_id_pk" PRIMARY KEY("tenant_id","project_id","baseline_version_id","source_activity_id","source_skill_id")
);
--> statement-breakpoint
CREATE TABLE "baseline_assignments" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"source_activity_id" uuid NOT NULL,
	"source_resource_id" uuid NOT NULL,
	"units_percent" integer NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_assignments_tenant_id_project_id_baseline_version_id_source_activity_id_source_resource_id_pk" PRIMARY KEY("tenant_id","project_id","baseline_version_id","source_activity_id","source_resource_id"),
	CONSTRAINT "baseline_assignments_units_range" CHECK ("baseline_assignments"."units_percent" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "baseline_resource_skills" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"source_resource_id" uuid NOT NULL,
	"source_skill_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_resource_skills_tenant_id_project_id_baseline_version_id_source_resource_id_source_skill_id_pk" PRIMARY KEY("tenant_id","project_id","baseline_version_id","source_resource_id","source_skill_id")
);
--> statement-breakpoint
CREATE TABLE "baseline_resources" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"source_resource_id" uuid NOT NULL,
	"name" text NOT NULL,
	"calendar_id" text NOT NULL,
	"daily_capacity_minutes" integer NOT NULL,
	"cost_rate_minor_per_hour" bigint NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_resources_tenant_id_project_id_baseline_version_id_source_resource_id_pk" PRIMARY KEY("tenant_id","project_id","baseline_version_id","source_resource_id"),
	CONSTRAINT "baseline_resources_name_not_blank" CHECK (length(trim("baseline_resources"."name")) > 0),
	CONSTRAINT "baseline_resources_daily_capacity_range" CHECK ("baseline_resources"."daily_capacity_minutes" between 1 and 1440),
	CONSTRAINT "baseline_resources_cost_rate_non_negative" CHECK ("baseline_resources"."cost_rate_minor_per_hour" >= 0)
);
--> statement-breakpoint
CREATE TABLE "baseline_skills" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"source_skill_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_skills_tenant_id_project_id_baseline_version_id_source_skill_id_pk" PRIMARY KEY("tenant_id","project_id","baseline_version_id","source_skill_id"),
	CONSTRAINT "baseline_skills_name_not_blank" CHECK (length(trim("baseline_skills"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "baseline_activity_skill_requirements" ADD CONSTRAINT "baseline_activity_skill_requirements_activity_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","source_activity_id") REFERENCES "public"."baseline_activities"("tenant_id","project_id","baseline_version_id","source_activity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_activity_skill_requirements" ADD CONSTRAINT "baseline_activity_skill_requirements_skill_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","source_skill_id") REFERENCES "public"."baseline_skills"("tenant_id","project_id","baseline_version_id","source_skill_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_assignments" ADD CONSTRAINT "baseline_assignments_activity_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","source_activity_id") REFERENCES "public"."baseline_activities"("tenant_id","project_id","baseline_version_id","source_activity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_assignments" ADD CONSTRAINT "baseline_assignments_resource_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","source_resource_id") REFERENCES "public"."baseline_resources"("tenant_id","project_id","baseline_version_id","source_resource_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_resource_skills" ADD CONSTRAINT "baseline_resource_skills_resource_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","source_resource_id") REFERENCES "public"."baseline_resources"("tenant_id","project_id","baseline_version_id","source_resource_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_resource_skills" ADD CONSTRAINT "baseline_resource_skills_skill_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","source_skill_id") REFERENCES "public"."baseline_skills"("tenant_id","project_id","baseline_version_id","source_skill_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_resources" ADD CONSTRAINT "baseline_resources_version_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id") REFERENCES "public"."baseline_versions"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_resources" ADD CONSTRAINT "baseline_resources_calendar_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","calendar_id") REFERENCES "public"."baseline_calendars"("tenant_id","project_id","baseline_version_id","source_calendar_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_skills" ADD CONSTRAINT "baseline_skills_version_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id") REFERENCES "public"."baseline_versions"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "baseline_assignments_resource_idx" ON "baseline_assignments" USING btree ("tenant_id","project_id","baseline_version_id","source_resource_id");--> statement-breakpoint
CREATE TRIGGER baseline_skills_immutable
BEFORE INSERT OR UPDATE OR DELETE ON baseline_skills
FOR EACH ROW EXECUTE FUNCTION guard_baseline_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER baseline_resources_immutable
BEFORE INSERT OR UPDATE OR DELETE ON baseline_resources
FOR EACH ROW EXECUTE FUNCTION guard_baseline_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER baseline_resource_skills_immutable
BEFORE INSERT OR UPDATE OR DELETE ON baseline_resource_skills
FOR EACH ROW EXECUTE FUNCTION guard_baseline_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER baseline_activity_skill_requirements_immutable
BEFORE INSERT OR UPDATE OR DELETE ON baseline_activity_skill_requirements
FOR EACH ROW EXECUTE FUNCTION guard_baseline_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER baseline_assignments_immutable
BEFORE INSERT OR UPDATE OR DELETE ON baseline_assignments
FOR EACH ROW EXECUTE FUNCTION guard_baseline_snapshot_mutation();
