ALTER TABLE fuel ADD COLUMN IF NOT EXISTS truck_id INTEGER REFERENCES trucks(id) ON DELETE SET NULL;
ALTER TABLE fuel ADD COLUMN IF NOT EXISTS odometer_km NUMERIC;

WITH candidates AS (
  SELECT f.id AS fuel_id, MIN(t.id) AS truck_id, COUNT(*) AS matches
  FROM fuel f
  JOIN trucks t
    ON t.company_id = f.company_id
   AND (
     UPPER(TRIM(f.truck)) = UPPER(t.patente)
     OR TRIM(f.truck) = t.id::text
   )
  WHERE f.truck_id IS NULL
    AND NULLIF(TRIM(f.truck), '') IS NOT NULL
  GROUP BY f.id
)
UPDATE fuel f
SET truck_id = candidates.truck_id
FROM candidates
WHERE f.id = candidates.fuel_id
  AND candidates.matches = 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fuel_odometer_nonnegative') THEN
    ALTER TABLE fuel ADD CONSTRAINT fuel_odometer_nonnegative CHECK (odometer_km >= 0) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fuel_company_truck_date
  ON fuel(company_id, truck_id, date DESC, id DESC);
