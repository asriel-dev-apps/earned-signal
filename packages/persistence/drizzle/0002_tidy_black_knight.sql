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
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;