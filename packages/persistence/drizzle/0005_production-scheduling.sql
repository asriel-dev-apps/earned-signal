CREATE TYPE "public"."schedule_constraint_type" AS ENUM('START_NO_EARLIER_THAN', 'FINISH_NO_LATER_THAN', 'MUST_START_ON', 'MUST_FINISH_ON');--> statement-breakpoint
CREATE TABLE "baseline_calendars" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"source_calendar_id" text NOT NULL,
	"name" text NOT NULL,
	"working_weekdays" integer[] NOT NULL,
	"non_working_dates" date[] NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baseline_calendars_tenant_id_project_id_baseline_version_id_source_calendar_id_pk" PRIMARY KEY("tenant_id","project_id","baseline_version_id","source_calendar_id"),
	CONSTRAINT "baseline_calendars_id_not_blank" CHECK (length(trim("baseline_calendars"."source_calendar_id")) > 0),
	CONSTRAINT "baseline_calendars_name_not_blank" CHECK (length(trim("baseline_calendars"."name")) > 0),
	CONSTRAINT "baseline_calendars_working_weekdays_known" CHECK (cardinality("baseline_calendars"."working_weekdays") > 0 and "baseline_calendars"."working_weekdays" <@ array[1,2,3,4,5,6,7]::integer[])
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
ALTER TABLE "activities" ADD COLUMN "calendar_id" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "constraint_type" "schedule_constraint_type";--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "constraint_date" date;--> statement-breakpoint
ALTER TABLE "baseline_activities" ADD COLUMN "calendar_id" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "baseline_activities" ADD COLUMN "constraint_type" "schedule_constraint_type";--> statement-breakpoint
ALTER TABLE "baseline_activities" ADD COLUMN "constraint_date" date;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_calendar_id" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "baseline_calendars" ADD CONSTRAINT "baseline_calendars_version_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id") REFERENCES "public"."baseline_versions"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calendars" ADD CONSTRAINT "project_calendars_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "project_calendars"
  ("tenant_id", "project_id", "id", "name", "working_weekdays", "non_working_dates")
SELECT "tenant_id", "id", 'standard', 'Standard Monday–Friday',
       ARRAY[1,2,3,4,5]::integer[], ARRAY[]::date[]
FROM "projects";--> statement-breakpoint
INSERT INTO "baseline_calendars"
  ("tenant_id", "project_id", "baseline_version_id", "source_calendar_id", "name",
   "working_weekdays", "non_working_dates")
SELECT "tenant_id", "project_id", "id", 'standard', 'Standard Monday–Friday',
       ARRAY[1,2,3,4,5]::integer[], ARRAY[]::date[]
FROM "baseline_versions";--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_calendar_fk" FOREIGN KEY ("tenant_id","project_id","calendar_id") REFERENCES "public"."project_calendars"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_activities" ADD CONSTRAINT "baseline_activities_calendar_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id","calendar_id") REFERENCES "public"."baseline_calendars"("tenant_id","project_id","baseline_version_id","source_calendar_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_constraint_complete" CHECK (("activities"."constraint_type" is null) = ("activities"."constraint_date" is null));--> statement-breakpoint
ALTER TABLE "baseline_activities" ADD CONSTRAINT "baseline_activities_constraint_complete" CHECK (("baseline_activities"."constraint_type" is null) = ("baseline_activities"."constraint_date" is null));--> statement-breakpoint
CREATE TRIGGER baseline_calendars_immutable
BEFORE INSERT OR UPDATE OR DELETE ON baseline_calendars
FOR EACH ROW EXECUTE FUNCTION guard_baseline_snapshot_mutation();
