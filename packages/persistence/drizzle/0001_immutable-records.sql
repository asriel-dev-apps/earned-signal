CREATE FUNCTION guard_baseline_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.approved_at IS NULL
     AND NEW.approved_at IS NOT NULL
     AND NEW.approved_by IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['approved_at', 'approved_by'])
         = (to_jsonb(OLD) - ARRAY['approved_at', 'approved_by']) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'baseline_versions records are immutable after approval'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION guard_baseline_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1
    FROM baseline_versions
    WHERE id = NEW.baseline_version_id
      AND tenant_id = NEW.tenant_id
      AND project_id = NEW.project_id
      AND approved_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'approved baseline snapshot records are immutable'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION reject_immutable_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% records are immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER baseline_versions_immutable
BEFORE UPDATE OR DELETE ON baseline_versions
FOR EACH ROW EXECUTE FUNCTION guard_baseline_version_mutation();
--> statement-breakpoint
CREATE TRIGGER baseline_wbs_nodes_immutable
BEFORE INSERT OR UPDATE OR DELETE ON baseline_wbs_nodes
FOR EACH ROW EXECUTE FUNCTION guard_baseline_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER baseline_activities_immutable
BEFORE INSERT OR UPDATE OR DELETE ON baseline_activities
FOR EACH ROW EXECUTE FUNCTION guard_baseline_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER baseline_dependencies_immutable
BEFORE INSERT OR UPDATE OR DELETE ON baseline_dependencies
FOR EACH ROW EXECUTE FUNCTION guard_baseline_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
