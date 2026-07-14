CREATE TYPE "public"."principal_type" AS ENUM('HUMAN', 'AGENT');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('OWNER', 'EDITOR', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."tenant_role" AS ENUM('OWNER', 'ADMIN', 'MEMBER');--> statement-breakpoint
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
CREATE TABLE "project_memberships" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" "project_role" NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_tenant_id_project_id_principal_id_pk" PRIMARY KEY("tenant_id","project_id","principal_id")
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
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_tenant_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."tenant_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "principals_issuer_subject_unique" ON "principals" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "project_memberships_principal_idx" ON "project_memberships" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "tenant_memberships_principal_idx" ON "tenant_memberships" USING btree ("principal_id");