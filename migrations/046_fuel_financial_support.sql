BEGIN;
ALTER TABLE fuel ADD COLUMN IF NOT EXISTS supply_type TEXT NOT NULL DEFAULT 'unspecified' CHECK(supply_type IN ('unspecified','external','internal'));
ALTER TABLE fuel ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'unspecified' CHECK(payment_method IN ('unspecified','cash','card','agreement','internal'));
ALTER TABLE fuel ADD COLUMN IF NOT EXISTS receipt_reference TEXT CHECK(length(receipt_reference)<=160);
ALTER TABLE fuel ADD COLUMN IF NOT EXISTS valuation_version INTEGER NOT NULL DEFAULT 0 CHECK(valuation_version>=0);
CREATE TABLE IF NOT EXISTS financial_support_entries (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),
 fuel_id INTEGER,cost_version_id BIGINT,source_id BIGINT,
 reference TEXT CHECK(length(reference)<=160),notes TEXT CHECK(length(notes)<=2000),
 storage_key TEXT UNIQUE,mime_type TEXT,size INTEGER,sha256 TEXT,
 created_by BIGINT NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(fuel_id,cost_version_id,source_id)=1),
 CHECK(nullif(trim(reference),'') IS NOT NULL OR storage_key IS NOT NULL),
 CHECK((storage_key IS NULL AND mime_type IS NULL AND size IS NULL AND sha256 IS NULL) OR
  (storage_key IS NOT NULL AND mime_type IS NOT NULL AND size IS NOT NULL AND sha256 IS NOT NULL AND mime_type IN ('application/pdf','image/png','image/jpeg') AND size BETWEEN 1 AND 5242880 AND sha256 ~ '^[a-f0-9]{64}$')),
 FOREIGN KEY(company_id,fuel_id) REFERENCES fuel(company_id,id),
 FOREIGN KEY(company_id,source_id) REFERENCES economic_sources(company_id,id),
 FOREIGN KEY(cost_version_id) REFERENCES trip_cost_versions(id)
);
CREATE INDEX IF NOT EXISTS financial_support_company_targets ON financial_support_entries(company_id,fuel_id,cost_version_id,source_id);
CREATE OR REPLACE FUNCTION guard_financial_support_company() RETURNS trigger AS $$ BEGIN
 IF NEW.cost_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM trip_cost_versions WHERE id=NEW.cost_version_id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'Versión de costo ajena a la empresa'; END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS financial_support_company ON financial_support_entries;
CREATE TRIGGER financial_support_company BEFORE INSERT ON financial_support_entries FOR EACH ROW EXECUTE FUNCTION guard_financial_support_company();
DROP TRIGGER IF EXISTS financial_support_immutable ON financial_support_entries;
CREATE TRIGGER financial_support_immutable BEFORE UPDATE OR DELETE ON financial_support_entries FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision();
COMMIT;
