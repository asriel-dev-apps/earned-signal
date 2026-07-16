CREATE TYPE "public"."scenario_status" AS ENUM('DRAFT', 'PUBLISHED', 'DISCARDED');--> statement-breakpoint
CREATE TABLE "scenario_audit_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"scenario_revision" bigint NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenario_audit_events_id_unique" UNIQUE("id"),
	CONSTRAINT "scenario_audit_events_revision_positive" CHECK ("scenario_audit_events"."scenario_revision" > 0),
	CONSTRAINT "scenario_audit_events_actor_id_not_blank" CHECK (length(trim("scenario_audit_events"."actor_id")) > 0),
	CONSTRAINT "scenario_audit_events_event_type_not_blank" CHECK (length(trim("scenario_audit_events"."event_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "scenario_runs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"source_project_revision" bigint NOT NULL,
	"source_scenario_revision" bigint NOT NULL,
	"algorithm_version" text NOT NULL,
	"input_hash" char(64) NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenario_runs_tenant_id_project_id_scenario_id_id_pk" PRIMARY KEY("tenant_id","project_id","scenario_id","id"),
	CONSTRAINT "scenario_runs_id_unique" UNIQUE("id"),
	CONSTRAINT "scenario_runs_project_revision_non_negative" CHECK ("scenario_runs"."source_project_revision" >= 0),
	CONSTRAINT "scenario_runs_scenario_revision_positive" CHECK ("scenario_runs"."source_scenario_revision" > 0),
	CONSTRAINT "scenario_runs_algorithm_version_not_blank" CHECK (length(trim("scenario_runs"."algorithm_version")) between 1 and 100),
	CONSTRAINT "scenario_runs_input_hash_hex" CHECK ("scenario_runs"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scenario_runs_actor_id_not_blank" CHECK (length(trim("scenario_runs"."actor_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "scenario_status" DEFAULT 'DRAFT' NOT NULL,
	"base_project_revision" bigint NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_run_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"published_by" text,
	"published_at" timestamp(6) with time zone,
	"discarded_by" text,
	"discarded_at" timestamp(6) with time zone,
	CONSTRAINT "scenarios_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "scenarios_id_unique" UNIQUE("id"),
	CONSTRAINT "scenarios_name_length" CHECK (length(trim("scenarios"."name")) between 1 and 200),
	CONSTRAINT "scenarios_base_revision_non_negative" CHECK ("scenarios"."base_project_revision" >= 0),
	CONSTRAINT "scenarios_revision_positive" CHECK ("scenarios"."revision" > 0),
	CONSTRAINT "scenarios_created_by_not_blank" CHECK (length(trim("scenarios"."created_by")) > 0),
	CONSTRAINT "scenarios_updated_by_not_blank" CHECK (length(trim("scenarios"."updated_by")) > 0),
	CONSTRAINT "scenarios_terminal_metadata_consistent" CHECK ((
        "scenarios"."status" = 'DRAFT' and "scenarios"."published_at" is null and "scenarios"."published_by" is null and "scenarios"."discarded_at" is null and "scenarios"."discarded_by" is null
      ) or (
        "scenarios"."status" = 'PUBLISHED' and "scenarios"."latest_run_id" is not null and "scenarios"."published_at" is not null and length(trim("scenarios"."published_by")) > 0 and "scenarios"."discarded_at" is null and "scenarios"."discarded_by" is null
      ) or (
        "scenarios"."status" = 'DISCARDED' and "scenarios"."discarded_at" is not null and length(trim("scenarios"."discarded_by")) > 0 and "scenarios"."published_at" is null and "scenarios"."published_by" is null
      ))
);
--> statement-breakpoint
ALTER TABLE "scenario_audit_events" ADD CONSTRAINT "scenario_audit_events_scenario_fk" FOREIGN KEY ("tenant_id","project_id","scenario_id") REFERENCES "public"."scenarios"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_scenario_fk" FOREIGN KEY ("tenant_id","project_id","scenario_id") REFERENCES "public"."scenarios"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scenario_audit_events_scenario_sequence_idx" ON "scenario_audit_events" USING btree ("tenant_id","project_id","scenario_id","sequence");--> statement-breakpoint
CREATE INDEX "scenario_runs_scenario_created_idx" ON "scenario_runs" USING btree ("tenant_id","project_id","scenario_id","created_at");--> statement-breakpoint
CREATE INDEX "scenarios_project_status_idx" ON "scenarios" USING btree ("tenant_id","project_id","status");
--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_latest_run_fk"
FOREIGN KEY ("tenant_id", "project_id", "id", "latest_run_id")
REFERENCES "scenario_runs"("tenant_id", "project_id", "scenario_id", "id")
ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION guard_scenario_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'terminal scenarios are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1 THEN
    RAISE EXCEPTION 'scenario revision must remain stable or increment by one'
      USING ERRCODE = '40001';
  END IF;

  IF (NEW.changes IS DISTINCT FROM OLD.changes OR NEW.status IS DISTINCT FROM OLD.status)
     AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'scenario changes and status transitions require a revision increment'
      USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER scenarios_guard_mutation
BEFORE UPDATE OR DELETE ON scenarios
FOR EACH ROW EXECUTE FUNCTION guard_scenario_mutation();
--> statement-breakpoint
CREATE TRIGGER scenario_runs_immutable
BEFORE UPDATE OR DELETE ON scenario_runs
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER scenario_audit_events_immutable
BEFORE UPDATE OR DELETE ON scenario_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
