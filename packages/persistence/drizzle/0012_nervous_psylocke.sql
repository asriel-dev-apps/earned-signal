CREATE TYPE "public"."staffing_proposal_status" AS ENUM('REQUESTED', 'RUNNING', 'READY', 'INFEASIBLE', 'UNKNOWN', 'FAILED');--> statement-breakpoint
CREATE TABLE "staffing_proposal_audit_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staffing_proposal_audit_events_id_unique" UNIQUE("id"),
	CONSTRAINT "staffing_proposal_audit_events_actor_id_not_blank" CHECK (length(trim("staffing_proposal_audit_events"."actor_id")) > 0),
	CONSTRAINT "staffing_proposal_audit_events_event_type_not_blank" CHECK (length(trim("staffing_proposal_audit_events"."event_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "staffing_proposal_runs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"status" "staffing_proposal_status" NOT NULL,
	"algorithm_version" text NOT NULL,
	"output" jsonb NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staffing_proposal_runs_tenant_id_project_id_proposal_id_id_pk" PRIMARY KEY("tenant_id","project_id","proposal_id","id"),
	CONSTRAINT "staffing_proposal_runs_id_unique" UNIQUE("id"),
	CONSTRAINT "staffing_proposal_runs_terminal_status" CHECK ("staffing_proposal_runs"."status" in ('READY', 'INFEASIBLE', 'UNKNOWN', 'FAILED')),
	CONSTRAINT "staffing_proposal_runs_algorithm_version_not_blank" CHECK (length(trim("staffing_proposal_runs"."algorithm_version")) between 1 and 100),
	CONSTRAINT "staffing_proposal_runs_actor_id_not_blank" CHECK (length(trim("staffing_proposal_runs"."actor_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "staffing_proposals" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "staffing_proposal_status" DEFAULT 'REQUESTED' NOT NULL,
	"base_project_revision" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" char(64) NOT NULL,
	"input" jsonb NOT NULL,
	"latest_run_id" uuid,
	"linked_scenario_id" uuid,
	"created_by_type" "audit_actor_type" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp(6) with time zone,
	"completed_at" timestamp(6) with time zone,
	CONSTRAINT "staffing_proposals_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "staffing_proposals_id_unique" UNIQUE("id"),
	CONSTRAINT "staffing_proposals_project_idempotency_unique" UNIQUE("tenant_id","project_id","idempotency_key"),
	CONSTRAINT "staffing_proposals_name_length" CHECK (length(trim("staffing_proposals"."name")) between 1 and 200),
	CONSTRAINT "staffing_proposals_base_revision_non_negative" CHECK ("staffing_proposals"."base_project_revision" >= 0),
	CONSTRAINT "staffing_proposals_idempotency_key_length" CHECK (length(trim("staffing_proposals"."idempotency_key")) between 1 and 200),
	CONSTRAINT "staffing_proposals_request_hash_hex" CHECK ("staffing_proposals"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "staffing_proposals_created_by_not_blank" CHECK (length(trim("staffing_proposals"."created_by")) > 0),
	CONSTRAINT "staffing_proposals_status_metadata_consistent" CHECK ((
        "staffing_proposals"."status" = 'REQUESTED' and "staffing_proposals"."started_at" is null and "staffing_proposals"."completed_at" is null and "staffing_proposals"."latest_run_id" is null
      ) or (
        "staffing_proposals"."status" = 'RUNNING' and "staffing_proposals"."started_at" is not null and "staffing_proposals"."completed_at" is null and "staffing_proposals"."latest_run_id" is null
      ) or (
        "staffing_proposals"."status" in ('READY', 'INFEASIBLE', 'UNKNOWN', 'FAILED') and "staffing_proposals"."completed_at" is not null and "staffing_proposals"."latest_run_id" is not null
      )),
	CONSTRAINT "staffing_proposals_scenario_requires_ready" CHECK ("staffing_proposals"."linked_scenario_id" is null or "staffing_proposals"."status" = 'READY')
);
--> statement-breakpoint
ALTER TABLE "staffing_proposal_audit_events" ADD CONSTRAINT "staffing_proposal_audit_events_proposal_fk" FOREIGN KEY ("tenant_id","project_id","proposal_id") REFERENCES "public"."staffing_proposals"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_proposal_runs" ADD CONSTRAINT "staffing_proposal_runs_proposal_fk" FOREIGN KEY ("tenant_id","project_id","proposal_id") REFERENCES "public"."staffing_proposals"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_proposals" ADD CONSTRAINT "staffing_proposals_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_proposals" ADD CONSTRAINT "staffing_proposals_linked_scenario_fk" FOREIGN KEY ("tenant_id","project_id","linked_scenario_id") REFERENCES "public"."scenarios"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staffing_proposal_audit_events_proposal_sequence_idx" ON "staffing_proposal_audit_events" USING btree ("tenant_id","project_id","proposal_id","sequence");--> statement-breakpoint
CREATE INDEX "staffing_proposal_runs_proposal_created_idx" ON "staffing_proposal_runs" USING btree ("tenant_id","project_id","proposal_id","created_at");--> statement-breakpoint
CREATE INDEX "staffing_proposals_project_status_idx" ON "staffing_proposals" USING btree ("tenant_id","project_id","status","created_at");
--> statement-breakpoint
ALTER TABLE "staffing_proposals" ADD CONSTRAINT "staffing_proposals_latest_run_fk"
FOREIGN KEY ("tenant_id", "project_id", "id", "latest_run_id")
REFERENCES "staffing_proposal_runs"("tenant_id", "project_id", "proposal_id", "id")
ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION guard_staffing_proposal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staffing proposals cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.base_project_revision IS DISTINCT FROM OLD.base_project_revision
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.input IS DISTINCT FROM OLD.input
     OR NEW.created_by_type IS DISTINCT FROM OLD.created_by_type
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'staffing proposal request records are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'REQUESTED' AND NEW.status NOT IN
       ('REQUESTED', 'RUNNING', 'READY', 'INFEASIBLE', 'UNKNOWN', 'FAILED') THEN
    RAISE EXCEPTION 'invalid staffing proposal status transition'
      USING ERRCODE = '40001';
  ELSIF OLD.status = 'RUNNING' AND NEW.status NOT IN
       ('RUNNING', 'READY', 'INFEASIBLE', 'UNKNOWN', 'FAILED') THEN
    RAISE EXCEPTION 'invalid staffing proposal status transition'
      USING ERRCODE = '40001';
  ELSIF OLD.status IN ('READY', 'INFEASIBLE', 'UNKNOWN', 'FAILED')
        AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal staffing proposal status is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('READY', 'INFEASIBLE', 'UNKNOWN', 'FAILED')
     AND (NEW.latest_run_id IS DISTINCT FROM OLD.latest_run_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'first terminal staffing proposal result is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.linked_scenario_id IS NOT NULL
     AND NEW.linked_scenario_id IS DISTINCT FROM OLD.linked_scenario_id THEN
    RAISE EXCEPTION 'linked staffing proposal scenario is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER staffing_proposals_guard_mutation
BEFORE UPDATE OR DELETE ON staffing_proposals
FOR EACH ROW EXECUTE FUNCTION guard_staffing_proposal_mutation();
--> statement-breakpoint
CREATE TRIGGER staffing_proposal_runs_immutable
BEFORE UPDATE OR DELETE ON staffing_proposal_runs
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
--> statement-breakpoint
CREATE TRIGGER staffing_proposal_audit_events_immutable
BEFORE UPDATE OR DELETE ON staffing_proposal_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
