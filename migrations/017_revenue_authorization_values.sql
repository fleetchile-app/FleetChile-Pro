-- FleetChile Pro - integración 4.3 con cambios de ingreso
BEGIN;
ALTER TABLE economic_authorization_requests
  ADD COLUMN IF NOT EXISTS previous_revenue_clp BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='economic_authorizations_previous_revenue_nonnegative') THEN
    ALTER TABLE economic_authorization_requests ADD CONSTRAINT economic_authorizations_previous_revenue_nonnegative
      CHECK (previous_revenue_clp IS NULL OR previous_revenue_clp >= 0);
  END IF;
END $$;
COMMIT;
