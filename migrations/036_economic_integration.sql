BEGIN;
ALTER TABLE economic_authorization_requests ADD COLUMN IF NOT EXISTS requested_revenue_includes_vat BOOLEAN;
ALTER TABLE economic_authorization_requests ADD COLUMN IF NOT EXISTS previous_revenue_includes_vat BOOLEAN;
ALTER TABLE economic_authorization_requests ADD COLUMN IF NOT EXISTS revenue_vat_recorded BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS trip_finance_control (
 trip_id BIGINT PRIMARY KEY,company_id BIGINT NOT NULL,version BIGINT NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
 FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id)
);
INSERT INTO trip_finance_control(trip_id,company_id,state)
 SELECT t.id,t.company_id,CASE WHEN p.economic_status='closed' THEN 'closed' ELSE 'open' END
 FROM trips t LEFT JOIN trip_economic_profiles p ON p.trip_id=t.id AND p.company_id=t.company_id ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION init_trip_finance() RETURNS trigger AS $$ BEGIN
 INSERT INTO trip_finance_control(trip_id,company_id) VALUES(NEW.id,NEW.company_id) ON CONFLICT DO NOTHING; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_init_trip_finance ON trips;
CREATE TRIGGER trg_init_trip_finance AFTER INSERT ON trips FOR EACH ROW EXECUTE FUNCTION init_trip_finance();
CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_company_identity ON fuel(company_id,id);
CREATE TABLE IF NOT EXISTS economic_sources (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),kind TEXT NOT NULL CHECK(kind IN ('fuel','toll')),
 provider TEXT NOT NULL,reference TEXT NOT NULL,fuel_id INTEGER,truck_id INTEGER,occurred_on DATE NOT NULL,
 amount_clp BIGINT NOT NULL CHECK(amount_clp>=0),includes_vat BOOLEAN,description TEXT NOT NULL,original JSONB NOT NULL,
 version BIGINT NOT NULL DEFAULT 0,created_by BIGINT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,fuel_id) REFERENCES fuel(company_id,id),FOREIGN KEY(company_id,truck_id) REFERENCES trucks(company_id,id),
 UNIQUE(company_id,kind,provider,reference),UNIQUE(company_id,id),UNIQUE(fuel_id)
);
CREATE TABLE IF NOT EXISTS economic_source_allocations (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,source_id BIGINT NOT NULL,trip_id BIGINT NOT NULL,cost_item_id BIGINT NOT NULL UNIQUE,
 amount_clp BIGINT NOT NULL CHECK(amount_clp>=0),reason TEXT NOT NULL,created_by BIGINT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(company_id,trip_id,id),
 FOREIGN KEY(company_id,source_id) REFERENCES economic_sources(company_id,id),FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id),
 FOREIGN KEY(company_id,cost_item_id) REFERENCES trip_cost_items(company_id,id)
);
CREATE TABLE IF NOT EXISTS trip_budget_revisions (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,trip_id BIGINT NOT NULL,version INTEGER NOT NULL,entries JSONB NOT NULL,
 reason TEXT NOT NULL,created_by BIGINT REFERENCES users(id),actor_name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(trip_id,version),FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id)
);
CREATE TABLE IF NOT EXISTS economic_source_reversals (
 id BIGSERIAL PRIMARY KEY,allocation_id BIGINT NOT NULL UNIQUE REFERENCES economic_source_allocations(id),
 company_id BIGINT NOT NULL,trip_id BIGINT NOT NULL,reason TEXT NOT NULL,created_by BIGINT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id),FOREIGN KEY(company_id,trip_id,allocation_id) REFERENCES economic_source_allocations(company_id,trip_id,id)
);
CREATE TABLE IF NOT EXISTS trip_distribution_revisions (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,trip_id BIGINT NOT NULL,version INTEGER NOT NULL,entries JSONB NOT NULL,
 basis_hash TEXT NOT NULL,basis JSONB NOT NULL,reason TEXT NOT NULL,created_by BIGINT REFERENCES users(id),actor_name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(trip_id,version),FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id)
);
CREATE TABLE IF NOT EXISTS trip_finance_events (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,trip_id BIGINT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('close','reopen')),
 reason TEXT NOT NULL,snapshot JSONB NOT NULL,created_by BIGINT REFERENCES users(id),actor_name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id)
);
DO $$ DECLARE tbl TEXT; BEGIN
 FOREACH tbl IN ARRAY ARRAY['economic_source_allocations','economic_source_reversals','trip_budget_revisions','trip_distribution_revisions','trip_finance_events'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS trg_finance_immutable ON %I',tbl);
  EXECUTE format('CREATE TRIGGER trg_finance_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision()',tbl);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION guard_financial_mutation() RETURNS trigger AS $$
DECLARE tid BIGINT;cid BIGINT;locked_state TEXT;
BEGIN
 IF TG_TABLE_NAME='trip_cost_versions' THEN
  SELECT trip_id,company_id INTO tid,cid FROM trip_cost_items WHERE id=COALESCE(NEW.trip_cost_item_id,OLD.trip_cost_item_id);
 ELSE tid:=COALESCE(NEW.trip_id,OLD.trip_id);cid:=COALESCE(NEW.company_id,OLD.company_id); END IF;
 SELECT state INTO locked_state FROM trip_finance_control WHERE trip_id=tid AND company_id=cid FOR UPDATE;
 IF locked_state='closed' THEN RAISE EXCEPTION 'ECONOMIC_CLOSED: reabre el cierre económico con motivo antes de modificar' USING ERRCODE='55000'; END IF;
 UPDATE trip_finance_control SET version=version+1 WHERE trip_id=tid AND company_id=cid;
 RETURN COALESCE(NEW,OLD);
END; $$ LANGUAGE plpgsql;
DO $$ DECLARE tbl TEXT; BEGIN
 FOREACH tbl IN ARRAY ARRAY['trip_cost_items','trip_cost_versions','trip_economic_profiles','trip_revenue_history','economic_authorization_requests','economic_source_allocations','economic_source_reversals','trip_budget_revisions','trip_distribution_revisions'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS trg_guard_financial_mutation ON %I',tbl);
  EXECUTE format('CREATE TRIGGER trg_guard_financial_mutation BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_financial_mutation()',tbl);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION guard_source_allocation() RETURNS trigger AS $$
DECLARE source_row economic_sources;item_row RECORD;used_amount NUMERIC;
BEGIN
 SELECT * INTO source_row FROM economic_sources WHERE id=NEW.source_id AND company_id=NEW.company_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Origen económico ajeno o inexistente'; END IF;
 SELECT i.trip_id,c.code,v.amount_clp,v.cost_basis,v.amount_includes_vat INTO item_row FROM trip_cost_items i
 JOIN economic_cost_categories c ON c.id=i.category_id JOIN trip_cost_versions v ON v.id=i.current_version_id AND v.trip_cost_item_id=i.id AND v.company_id=i.company_id
 WHERE i.id=NEW.cost_item_id AND i.company_id=NEW.company_id;
 IF NOT FOUND OR item_row.trip_id<>NEW.trip_id OR item_row.code<>source_row.kind OR item_row.amount_clp<>NEW.amount_clp OR item_row.cost_basis NOT IN ('observed','allocated') OR item_row.amount_includes_vat IS DISTINCT FROM source_row.includes_vat THEN RAISE EXCEPTION 'Costo incompatible con el origen económico'; END IF;
 SELECT COALESCE(SUM(a.amount_clp),0) INTO used_amount FROM economic_source_allocations a WHERE source_id=NEW.source_id AND NOT EXISTS(SELECT 1 FROM economic_source_reversals x WHERE x.allocation_id=a.id);
 IF used_amount+NEW.amount_clp>source_row.amount_clp THEN RAISE EXCEPTION 'SOURCE_EXCEEDED: el origen ya está distribuido' USING ERRCODE='55000'; END IF;
 UPDATE economic_sources SET version=version+1 WHERE id=NEW.source_id; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_source_allocation ON economic_source_allocations;
CREATE TRIGGER trg_guard_source_allocation BEFORE INSERT ON economic_source_allocations FOR EACH ROW EXECUTE FUNCTION guard_source_allocation();
CREATE OR REPLACE FUNCTION guard_linked_cost_pointer() RETURNS trigger AS $$
DECLARE linked economic_source_allocations;v trip_cost_versions;
BEGIN
 SELECT a.* INTO linked FROM economic_source_allocations a WHERE cost_item_id=NEW.id AND NOT EXISTS(SELECT 1 FROM economic_source_reversals x WHERE x.allocation_id=a.id);
 IF FOUND THEN
  SELECT * INTO v FROM trip_cost_versions WHERE id=NEW.current_version_id AND trip_cost_item_id=NEW.id;
  IF NEW.status='voided' OR NEW.trip_id<>linked.trip_id OR NEW.company_id<>linked.company_id OR NEW.category_id<>OLD.category_id OR v.amount_clp<>linked.amount_clp OR v.cost_basis NOT IN ('observed','allocated') OR v.amount_includes_vat IS DISTINCT FROM (SELECT includes_vat FROM economic_sources WHERE id=linked.source_id) THEN
   RAISE EXCEPTION 'SOURCE_LINKED: el costo está vinculado a un origen inmutable; no puede cambiarse su importe, viaje, categoría o base' USING ERRCODE='55000';
  END IF;
 END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_linked_cost_pointer ON trip_cost_items;
CREATE TRIGGER trg_guard_linked_cost_pointer BEFORE UPDATE ON trip_cost_items FOR EACH ROW EXECUTE FUNCTION guard_linked_cost_pointer();
CREATE OR REPLACE FUNCTION guard_economic_source() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.company_id,NEW.kind,NEW.provider,NEW.reference,NEW.fuel_id,NEW.truck_id,NEW.occurred_on,NEW.amount_clp,NEW.includes_vat,NEW.original,NEW.description)
 IS DISTINCT FROM ROW(OLD.company_id,OLD.kind,OLD.provider,OLD.reference,OLD.fuel_id,OLD.truck_id,OLD.occurred_on,OLD.amount_clp,OLD.includes_vat,OLD.original,OLD.description) THEN RAISE EXCEPTION 'El origen conserva su identidad e importe original'; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_economic_source ON economic_sources;
CREATE TRIGGER trg_guard_economic_source BEFORE UPDATE OR DELETE ON economic_sources FOR EACH ROW EXECUTE FUNCTION guard_economic_source();
CREATE OR REPLACE FUNCTION guard_linked_fuel() RETURNS trigger AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM economic_sources WHERE fuel_id=OLD.id) AND (TG_OP='DELETE' OR ROW(NEW.company_id,NEW.truck_id,NEW.date,NEW.total_clp) IS DISTINCT FROM ROW(OLD.company_id,OLD.truck_id,OLD.date,OLD.total_clp)) THEN
  RAISE EXCEPTION 'El combustible tiene origen económico registrado: conserva fecha, vehículo e importe original'; END IF; RETURN COALESCE(NEW,OLD);
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_linked_fuel ON fuel;
CREATE TRIGGER trg_guard_linked_fuel BEFORE UPDATE OR DELETE ON fuel FOR EACH ROW EXECUTE FUNCTION guard_linked_fuel();
CREATE OR REPLACE FUNCTION guard_trip_financial_values() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
 IF ROW(NEW.revenue_clp,NEW.distance_km,NEW.planned_route_snapshot_id,NEW.itinerary_version) IS DISTINCT FROM ROW(OLD.revenue_clp,OLD.distance_km,OLD.planned_route_snapshot_id,OLD.itinerary_version) THEN
  SELECT state INTO st FROM trip_finance_control WHERE trip_id=OLD.id AND company_id=OLD.company_id FOR UPDATE;
  IF st='closed' THEN RAISE EXCEPTION 'ECONOMIC_CLOSED: reabre antes de cambiar valores económicos o su distancia base' USING ERRCODE='55000'; END IF;
  UPDATE trip_finance_control SET version=version+1 WHERE trip_id=OLD.id;
 END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_trip_financial_values ON trips;
CREATE TRIGGER trg_guard_trip_financial_values BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION guard_trip_financial_values();
CREATE OR REPLACE FUNCTION immutable_cost_values() RETURNS trigger AS $$ BEGIN
 IF ROW(NEW.company_id,NEW.trip_cost_item_id,NEW.version_number,NEW.amount_clp,NEW.amount_includes_vat,NEW.cost_basis,NEW.support_status,NEW.justification,NEW.description,NEW.effective_date,NEW.supersedes_version_id)
 IS DISTINCT FROM ROW(OLD.company_id,OLD.trip_cost_item_id,OLD.version_number,OLD.amount_clp,OLD.amount_includes_vat,OLD.cost_basis,OLD.support_status,OLD.justification,OLD.description,OLD.effective_date,OLD.supersedes_version_id) THEN
  RAISE EXCEPTION 'Los valores del costo conservan su versión; crea otra versión para corregirlos'; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_immutable_cost_values ON trip_cost_versions;
CREATE TRIGGER trg_immutable_cost_values BEFORE UPDATE ON trip_cost_versions FOR EACH ROW EXECUTE FUNCTION immutable_cost_values();
COMMIT;
