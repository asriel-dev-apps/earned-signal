CREATE TRIGGER command_receipts_immutable
BEFORE UPDATE OR DELETE ON command_receipts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
