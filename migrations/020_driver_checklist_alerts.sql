ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution_note TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='alerts_source_type_valid') THEN
    ALTER TABLE alerts DROP CONSTRAINT alerts_source_type_valid;
  END IF;
  ALTER TABLE alerts ADD CONSTRAINT alerts_source_type_valid
    CHECK (source_type IS NULL OR source_type IN ('maintenance','vehicle_document','driver_document','truck','checklist')) NOT VALID;
END $$;

CREATE INDEX IF NOT EXISTS idx_alerts_checklist_source
  ON alerts(source_type, source_id, condition_code)
  WHERE source_type = 'checklist';
