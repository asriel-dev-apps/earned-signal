CREATE TYPE "public"."forecast_run_status" AS ENUM('REQUESTED', 'RUNNING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TABLE "forecast_run_audit_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"forecast_run_id" uuid NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_run_audit_events_id_unique" UNIQUE("id"),
	CONSTRAINT "forecast_run_audit_events_actor_id_not_blank" CHECK (length(trim("forecast_run_audit_events"."actor_id")) > 0),
	CONSTRAINT "forecast_run_audit_events_event_type_not_blank" CHECK (length(trim("forecast_run_audit_events"."event_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "forecast_run_results" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"forecast_run_id" uuid NOT NULL,
	"status" "forecast_run_status" NOT NULL,
	"algorithm_version" text NOT NULL,
	"output" jsonb NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_run_results_tenant_id_project_id_scenario_id_forecast_run_id_id_pk" PRIMARY KEY("tenant_id","project_id","scenario_id","forecast_run_id","id"),
	CONSTRAINT "forecast_run_results_id_unique" UNIQUE("id"),
	CONSTRAINT "forecast_run_results_run_unique" UNIQUE("tenant_id","project_id","scenario_id","forecast_run_id"),
	CONSTRAINT "forecast_run_results_terminal_status" CHECK ("forecast_run_results"."status" in ('READY', 'FAILED')),
	CONSTRAINT "forecast_run_results_algorithm_version_not_blank" CHECK (length(trim("forecast_run_results"."algorithm_version")) between 1 and 100),
	CONSTRAINT "forecast_run_results_actor_id_not_blank" CHECK (length(trim("forecast_run_results"."actor_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "forecast_runs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"status" "forecast_run_status" DEFAULT 'REQUESTED' NOT NULL,
	"source_project_revision" bigint NOT NULL,
	"source_scenario_revision" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" char(64) NOT NULL,
	"input" jsonb NOT NULL,
	"latest_result_id" uuid,
	"created_by_type" "audit_actor_type" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp(6) with time zone,
	"completed_at" timestamp(6) with time zone,
	CONSTRAINT "forecast_runs_tenant_id_project_id_scenario_id_id_pk" PRIMARY KEY("tenant_id","project_id","scenario_id","id"),
	CONSTRAINT "forecast_runs_id_unique" UNIQUE("id"),
	CONSTRAINT "forecast_runs_scenario_idempotency_unique" UNIQUE("tenant_id","project_id","scenario_id","idempotency_key"),
	CONSTRAINT "forecast_runs_project_revision_non_negative" CHECK ("forecast_runs"."source_project_revision" >= 0),
	CONSTRAINT "forecast_runs_scenario_revision_positive" CHECK ("forecast_runs"."source_scenario_revision" > 0),
	CONSTRAINT "forecast_runs_idempotency_key_length" CHECK (length(trim("forecast_runs"."idempotency_key")) between 1 and 200),
	CONSTRAINT "forecast_runs_request_hash_hex" CHECK ("forecast_runs"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "forecast_runs_created_by_not_blank" CHECK (length(trim("forecast_runs"."created_by")) > 0),
	CONSTRAINT "forecast_runs_status_metadata_consistent" CHECK ((
        "forecast_runs"."status" = 'REQUESTED' and "forecast_runs"."started_at" is null and "forecast_runs"."completed_at" is null and "forecast_runs"."latest_result_id" is null
      ) or (
        "forecast_runs"."status" = 'RUNNING' and "forecast_runs"."started_at" is not null and "forecast_runs"."completed_at" is null and "forecast_runs"."latest_result_id" is null
      ) or (
        "forecast_runs"."status" in ('READY', 'FAILED') and "forecast_runs"."started_at" is not null and "forecast_runs"."completed_at" is not null and "forecast_runs"."latest_result_id" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "forecast_run_audit_events" ADD CONSTRAINT "forecast_run_audit_events_run_fk" FOREIGN KEY ("tenant_id","project_id","scenario_id","forecast_run_id") REFERENCES "public"."forecast_runs"("tenant_id","project_id","scenario_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_run_results" ADD CONSTRAINT "forecast_run_results_run_fk" FOREIGN KEY ("tenant_id","project_id","scenario_id","forecast_run_id") REFERENCES "public"."forecast_runs"("tenant_id","project_id","scenario_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_scenario_fk" FOREIGN KEY ("tenant_id","project_id","scenario_id") REFERENCES "public"."scenarios"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forecast_run_audit_events_run_sequence_idx" ON "forecast_run_audit_events" USING btree ("tenant_id","project_id","scenario_id","forecast_run_id","sequence");--> statement-breakpoint
CREATE INDEX "forecast_runs_scenario_status_idx" ON "forecast_runs" USING btree ("tenant_id","project_id","scenario_id","status","created_at");
--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_latest_result_fk"
FOREIGN KEY ("tenant_id", "project_id", "scenario_id", "id", "latest_result_id")
REFERENCES "forecast_run_results"("tenant_id", "project_id", "scenario_id", "forecast_run_id", "id")
ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION guard_forecast_run_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'forecast runs cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_project_revision IS DISTINCT FROM OLD.source_project_revision
     OR NEW.source_scenario_revision IS DISTINCT FROM OLD.source_scenario_revision
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.input IS DISTINCT FROM OLD.input
     OR NEW.created_by_type IS DISTINCT FROM OLD.created_by_type
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'forecast run request records are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'REQUESTED' AND NEW.status NOT IN ('REQUESTED', 'RUNNING', 'FAILED') THEN
    RAISE EXCEPTION 'invalid forecast run status transition'
      USING ERRCODE = '40001';
  ELSIF OLD.status = 'RUNNING' AND NEW.status NOT IN ('RUNNING', 'READY', 'FAILED') THEN
    RAISE EXCEPTION 'invalid forecast run status transition'
      USING ERRCODE = '40001';
  ELSIF OLD.status IN ('READY', 'FAILED') THEN
    RAISE EXCEPTION 'terminal forecast runs are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forecast_runs_guard_mutation
BEFORE UPDATE OR DELETE ON forecast_runs
FOR EACH ROW EXECUTE FUNCTION guard_forecast_run_mutation();
--> statement-breakpoint
CREATE TRIGGER forecast_run_results_immutable
BEFORE UPDATE OR DELETE ON forecast_run_results
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER forecast_run_audit_events_immutable
BEFORE UPDATE OR DELETE ON forecast_run_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
