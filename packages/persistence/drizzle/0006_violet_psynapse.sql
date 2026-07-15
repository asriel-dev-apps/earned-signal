ALTER TABLE "baseline_versions" ADD COLUMN "default_calendar_id" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_calendar_fk"
  FOREIGN KEY ("tenant_id", "id", "default_calendar_id")
  REFERENCES "project_calendars" ("tenant_id", "project_id", "id")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "baseline_versions" ADD CONSTRAINT "baseline_versions_default_calendar_fk"
  FOREIGN KEY ("tenant_id", "project_id", "id", "default_calendar_id")
  REFERENCES "baseline_calendars"
    ("tenant_id", "project_id", "baseline_version_id", "source_calendar_id")
  DEFERRABLE INITIALLY DEFERRED;
