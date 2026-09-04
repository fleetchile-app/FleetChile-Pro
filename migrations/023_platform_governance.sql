BEGIN;

-- Plataforma: licencia y capacidades por tenant, sin alterar la identidad existente.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_code TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_started_at DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_expires_at DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{"fleet":true,"drivers":true,"fuel":true,"routes":true,"loads":true,"gps":true,"pod":true,"reports":true}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS user_limit INTEGER NOT NULL DEFAULT 50;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS truck_limit INTEGER NOT NULL DEFAULT 50;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='companies_license_status_valid') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_license_status_valid CHECK (license_status IN ('active','trial','suspended','expired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='companies_limits_valid') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_limits_valid CHECK (user_limit > 0 AND truck_limit > 0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_companies_license_status ON companies(license_status, active);

COMMIT;
