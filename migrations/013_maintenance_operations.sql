ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS truck_id INTEGER REFERENCES trucks(id) ON DELETE SET NULL;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS maintenance_type TEXT;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS performed_at DATE;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS odometer_km NUMERIC;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS workshop TEXT;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS parts_description TEXT;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS parts_cost_clp BIGINT NOT NULL DEFAULT 0;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS labor_cost_clp BIGINT NOT NULL DEFAULT 0;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS next_due_date DATE;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS next_due_odometer_km NUMERIC;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

WITH candidates AS (
  SELECT m.id AS maintenance_id, MIN(t.id) AS truck_id, COUNT(*) AS matches
  FROM maintenance m
  JOIN trucks t
    ON t.company_id = m.company_id
   AND (
     UPPER(TRIM(m.truck)) = UPPER(t.patente)
     OR TRIM(m.truck) = t.id::text
   )
  WHERE m.truck_id IS NULL
    AND NULLIF(TRIM(m.truck), '') IS NOT NULL
  GROUP BY m.id
)
UPDATE maintenance m
SET truck_id = candidates.truck_id
FROM candidates
WHERE m.id = candidates.maintenance_id
  AND candidates.matches = 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_odometer_nonnegative') THEN
    ALTER TABLE maintenance ADD CONSTRAINT maintenance_odometer_nonnegative CHECK (odometer_km >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_next_odometer_nonnegative') THEN
    ALTER TABLE maintenance ADD CONSTRAINT maintenance_next_odometer_nonnegative CHECK (next_due_odometer_km >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_parts_cost_nonnegative') THEN
    ALTER TABLE maintenance ADD CONSTRAINT maintenance_parts_cost_nonnegative CHECK (parts_cost_clp >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_labor_cost_nonnegative') THEN
    ALTER TABLE maintenance ADD CONSTRAINT maintenance_labor_cost_nonnegative CHECK (labor_cost_clp >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_total_cost_nonnegative') THEN
    ALTER TABLE maintenance ADD CONSTRAINT maintenance_total_cost_nonnegative CHECK (cost_clp >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_type_valid') THEN
    ALTER TABLE maintenance ADD CONSTRAINT maintenance_type_valid CHECK (maintenance_type IS NULL OR maintenance_type IN ('Preventiva','Correctiva')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_status_valid') THEN
    ALTER TABLE maintenance ADD CONSTRAINT maintenance_status_valid CHECK (status IN ('Pendiente','En proceso','Completada','Cancelada')) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_maintenance_company_truck_date
  ON maintenance(company_id, truck_id, performed_at DESC, due DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_company_next_due
  ON maintenance(company_id, next_due_date, status);
