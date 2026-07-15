CREATE TABLE "activity_skill_requirements" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_skill_requirements_tenant_id_project_id_activity_id_skill_id_pk" PRIMARY KEY("tenant_id","project_id","activity_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"units_percent" integer NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignments_tenant_id_project_id_activity_id_resource_id_pk" PRIMARY KEY("tenant_id","project_id","activity_id","resource_id"),
	CONSTRAINT "assignments_units_range" CHECK ("assignments"."units_percent" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "resource_skills" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_skills_tenant_id_project_id_resource_id_skill_id_pk" PRIMARY KEY("tenant_id","project_id","resource_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"calendar_id" text NOT NULL,
	"daily_capacity_minutes" integer NOT NULL,
	"cost_rate_minor_per_hour" bigint NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "resources_name_not_blank" CHECK (length(trim("resources"."name")) > 0),
	CONSTRAINT "resources_daily_capacity_range" CHECK ("resources"."daily_capacity_minutes" between 1 and 1440),
	CONSTRAINT "resources_cost_rate_non_negative" CHECK ("resources"."cost_rate_minor_per_hour" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "skills_name_not_blank" CHECK (length(trim("skills"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "activity_skill_requirements" ADD CONSTRAINT "activity_skill_requirements_activity_fk" FOREIGN KEY ("tenant_id","project_id","activity_id") REFERENCES "public"."activities"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_skill_requirements" ADD CONSTRAINT "activity_skill_requirements_skill_fk" FOREIGN KEY ("tenant_id","project_id","skill_id") REFERENCES "public"."skills"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_activity_fk" FOREIGN KEY ("tenant_id","project_id","activity_id") REFERENCES "public"."activities"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_resource_fk" FOREIGN KEY ("tenant_id","project_id","resource_id") REFERENCES "public"."resources"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_skills" ADD CONSTRAINT "resource_skills_resource_fk" FOREIGN KEY ("tenant_id","project_id","resource_id") REFERENCES "public"."resources"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_skills" ADD CONSTRAINT "resource_skills_skill_fk" FOREIGN KEY ("tenant_id","project_id","skill_id") REFERENCES "public"."skills"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_calendar_fk" FOREIGN KEY ("tenant_id","project_id","calendar_id") REFERENCES "public"."project_calendars"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignments_resource_idx" ON "assignments" USING btree ("tenant_id","project_id","resource_id");