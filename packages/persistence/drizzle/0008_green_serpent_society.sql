CREATE TABLE "evm_snapshot_wbs_variances" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status_date" date NOT NULL,
	"activity_id" uuid NOT NULL,
	"wbs" text NOT NULL,
	"rank" integer NOT NULL,
	"pv" numeric(20, 2) NOT NULL,
	"ev" numeric(20, 2) NOT NULL,
	"ac" numeric(20, 2) NOT NULL,
	"sv" numeric(20, 2) NOT NULL,
	"cv" numeric(20, 2) NOT NULL,
	CONSTRAINT "evm_snapshot_wbs_variances_tenant_id_project_id_status_date_activity_id_pk" PRIMARY KEY("tenant_id","project_id","status_date","activity_id"),
	CONSTRAINT "evm_snapshot_wbs_variances_rank_unique" UNIQUE("tenant_id","project_id","status_date","rank"),
	CONSTRAINT "evm_snapshot_wbs_variances_wbs_not_blank" CHECK (length(trim("evm_snapshot_wbs_variances"."wbs")) > 0),
	CONSTRAINT "evm_snapshot_wbs_variances_rank_positive" CHECK ("evm_snapshot_wbs_variances"."rank" > 0)
);
--> statement-breakpoint
CREATE TABLE "evm_snapshots" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status_date" date NOT NULL,
	"baseline_version_id" uuid NOT NULL,
	"bac" numeric(20, 2) NOT NULL,
	"pv" numeric(20, 2) NOT NULL,
	"ev" numeric(20, 2) NOT NULL,
	"ac" numeric(20, 2) NOT NULL,
	"sv" numeric(20, 2) NOT NULL,
	"cv" numeric(20, 2) NOT NULL,
	"spi" numeric(20, 4),
	"cpi" numeric(20, 4),
	"eac" numeric(20, 2),
	"etc" numeric(20, 2),
	"vac" numeric(20, 2),
	"tcpi" numeric(20, 4),
	"calculated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evm_snapshots_tenant_id_project_id_status_date_pk" PRIMARY KEY("tenant_id","project_id","status_date"),
	CONSTRAINT "evm_snapshots_non_negative_totals" CHECK ("evm_snapshots"."bac" >= 0 and "evm_snapshots"."pv" >= 0 and "evm_snapshots"."ev" >= 0 and "evm_snapshots"."ac" >= 0)
);
--> statement-breakpoint
CREATE TABLE "period_buckets" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status_date" date NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "period_buckets_tenant_id_project_id_status_date_pk" PRIMARY KEY("tenant_id","project_id","status_date"),
	CONSTRAINT "period_buckets_dates_ordered" CHECK ("period_buckets"."period_start" <= "period_buckets"."status_date" and "period_buckets"."status_date" <= "period_buckets"."period_end")
);
--> statement-breakpoint
ALTER TABLE "evm_snapshot_wbs_variances" ADD CONSTRAINT "evm_snapshot_wbs_variances_snapshot_fk" FOREIGN KEY ("tenant_id","project_id","status_date") REFERENCES "public"."evm_snapshots"("tenant_id","project_id","status_date") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evm_snapshots" ADD CONSTRAINT "evm_snapshots_period_bucket_fk" FOREIGN KEY ("tenant_id","project_id","status_date") REFERENCES "public"."period_buckets"("tenant_id","project_id","status_date") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evm_snapshots" ADD CONSTRAINT "evm_snapshots_baseline_version_fk" FOREIGN KEY ("tenant_id","project_id","baseline_version_id") REFERENCES "public"."baseline_versions"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_buckets" ADD CONSTRAINT "period_buckets_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;