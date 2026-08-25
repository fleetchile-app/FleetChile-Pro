-- FleetChile Pro - conciliación explícita de costos directos
BEGIN;

ALTER TABLE trip_cost_versions
  ADD COLUMN IF NOT EXISTS reconciled_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trip_cost_versions_reconciliation_metadata') THEN
    ALTER TABLE trip_cost_versions ADD CONSTRAINT trip_cost_versions_reconciliation_metadata CHECK (
      (status = 'reconciled'
        AND reconciled_by IS NOT NULL
        AND reconciled_at IS NOT NULL
        AND NULLIF(BTRIM(reconciliation_reason), '') IS NOT NULL)
      OR
      (status <> 'reconciled'
        AND reconciled_by IS NULL
        AND reconciled_at IS NULL
        AND reconciliation_reason IS NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trip_cost_versions_reconciled
  ON trip_cost_versions(company_id, status, reconciled_at, reconciled_by);

COMMIT;
