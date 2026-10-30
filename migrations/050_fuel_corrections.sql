BEGIN;
-- Replacement records retain the original fuel, economic source and receipt.
CREATE TABLE IF NOT EXISTS fuel_corrections (
 id BIGSERIAL PRIMARY KEY, company_id BIGINT NOT NULL,
 previous_fuel_id INTEGER NOT NULL UNIQUE, fuel_id INTEGER NOT NULL UNIQUE,
 reason TEXT NOT NULL CHECK(length(trim(reason))>=5), created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(previous_fuel_id<fuel_id),
 FOREIGN KEY(company_id,previous_fuel_id) REFERENCES fuel(company_id,id),
 FOREIGN KEY(company_id,fuel_id) REFERENCES fuel(company_id,id)
);
DROP TRIGGER IF EXISTS fuel_corrections_immutable ON fuel_corrections;
CREATE TRIGGER fuel_corrections_immutable BEFORE UPDATE OR DELETE ON fuel_corrections FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision();
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='support_company_identity' AND conrelid='financial_support_entries'::regclass) THEN
 ALTER TABLE financial_support_entries ADD CONSTRAINT support_company_identity UNIQUE(company_id,id);
 END IF;
END; $$;
CREATE TABLE IF NOT EXISTS fuel_inherited_support (
 company_id BIGINT NOT NULL, fuel_id INTEGER NOT NULL, entry_id BIGINT NOT NULL,
 PRIMARY KEY(fuel_id,entry_id), FOREIGN KEY(company_id,fuel_id) REFERENCES fuel(company_id,id),
 FOREIGN KEY(company_id,entry_id) REFERENCES financial_support_entries(company_id,id)
);
DROP TRIGGER IF EXISTS fuel_inherited_support_immutable ON fuel_inherited_support;
CREATE TRIGGER fuel_inherited_support_immutable BEFORE UPDATE OR DELETE ON fuel_inherited_support FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision();
CREATE OR REPLACE VIEW financial_support_base_links AS
 SELECT company_id,'fuel'::text kind,fuel_id::bigint target_id,id entry_id FROM financial_support_entries WHERE fuel_id IS NOT NULL
 UNION SELECT company_id,'cost',cost_version_id,id FROM financial_support_entries WHERE cost_version_id IS NOT NULL
 UNION SELECT company_id,'source',source_id,id FROM financial_support_entries WHERE source_id IS NOT NULL
 UNION
 SELECT a.company_id,'fuel',s.fuel_id,e.id FROM economic_source_allocations a
 JOIN economic_sources s ON s.id=a.source_id AND s.company_id=a.company_id
 JOIN financial_support_entries e ON e.company_id=a.company_id AND
 (e.source_id=s.id OR e.cost_version_id IN (SELECT id FROM trip_cost_versions WHERE trip_cost_item_id=a.cost_item_id AND company_id=a.company_id))
 WHERE s.fuel_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM economic_source_reversals r WHERE r.allocation_id=a.id)
 UNION
 SELECT a.company_id,'source',s.id,e.id FROM economic_source_allocations a
 JOIN economic_sources s ON s.id=a.source_id AND s.company_id=a.company_id
 JOIN financial_support_entries e ON e.company_id=a.company_id AND
 (e.fuel_id=s.fuel_id OR e.cost_version_id IN (SELECT id FROM trip_cost_versions WHERE trip_cost_item_id=a.cost_item_id AND company_id=a.company_id))
 WHERE NOT EXISTS(SELECT 1 FROM economic_source_reversals r WHERE r.allocation_id=a.id)
 UNION
 SELECT a.company_id,'cost',v.id,e.id FROM economic_source_allocations a
 JOIN economic_sources s ON s.id=a.source_id AND s.company_id=a.company_id
 JOIN trip_cost_versions v ON v.trip_cost_item_id=a.cost_item_id AND v.company_id=a.company_id
 JOIN financial_support_entries e ON e.company_id=a.company_id AND (e.fuel_id=s.fuel_id OR e.source_id=s.id)
 WHERE NOT EXISTS(SELECT 1 FROM economic_source_reversals r WHERE r.allocation_id=a.id)
 UNION
 SELECT s.company_id,'source',s.id,e.id FROM economic_sources s
 JOIN financial_support_entries e ON e.fuel_id=s.fuel_id AND e.company_id=s.company_id;
CREATE OR REPLACE VIEW financial_support_links AS
 SELECT * FROM financial_support_base_links
 UNION SELECT company_id,'fuel',fuel_id::bigint,entry_id FROM fuel_inherited_support
 UNION SELECT h.company_id,'source',s.id,h.entry_id FROM fuel_inherited_support h JOIN economic_sources s ON s.company_id=h.company_id AND s.fuel_id=h.fuel_id
 UNION SELECT h.company_id,'cost',v.id,h.entry_id FROM fuel_inherited_support h
 JOIN economic_sources s ON s.company_id=h.company_id AND s.fuel_id=h.fuel_id
 JOIN economic_source_allocations a ON a.company_id=s.company_id AND a.source_id=s.id
 JOIN trip_cost_versions v ON v.company_id=a.company_id AND v.trip_cost_item_id=a.cost_item_id
 WHERE NOT EXISTS(SELECT 1 FROM economic_source_reversals r WHERE r.allocation_id=a.id);
CREATE OR REPLACE FUNCTION guard_retired_fuel_source() RETURNS trigger AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM economic_sources s JOIN fuel_corrections c ON c.previous_fuel_id=s.fuel_id AND c.company_id=s.company_id WHERE s.id=NEW.source_id) THEN
 RAISE EXCEPTION 'El abastecimiento fue rectificado; selecciona su reemplazo' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS retired_fuel_source ON economic_source_allocations;
CREATE TRIGGER retired_fuel_source BEFORE INSERT ON economic_source_allocations FOR EACH ROW EXECUTE FUNCTION guard_retired_fuel_source();
COMMIT;
