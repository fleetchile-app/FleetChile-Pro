ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_id BIGINT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS condition_code TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='alerts_source_type_valid') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_source_type_valid
      CHECK (source_type IS NULL OR source_type IN ('maintenance','vehicle_document','driver_document','truck')) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_active_condition
  ON alerts(company_id, source_type, source_id, condition_code)
  WHERE resolved = false
    AND source_type IS NOT NULL
    AND source_id IS NOT NULL
    AND condition_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_alerts_company_history
  ON alerts(company_id, resolved, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_source
  ON alerts(source_type, source_id, condition_code);
