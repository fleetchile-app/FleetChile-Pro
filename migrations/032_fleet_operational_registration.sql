BEGIN;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS vin TEXT;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS engine_number TEXT;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS profile_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trucks ALTER COLUMN capacidad_t DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_trucks_company_id ON trucks(company_id,id);

ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS road_requirement_code TEXT CHECK(road_requirement_code IN ('circulation','soap','inspection'));
ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS road_requirement_superseded BOOLEAN NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION vehicle_road_requirement_code(label TEXT) RETURNS TEXT AS $$
 SELECT CASE lower(btrim(label))
 WHEN 'permiso de circulación' THEN 'circulation' WHEN 'permiso de circulacion' THEN 'circulation' WHEN 'permiso_circulacion' THEN 'circulation'
 WHEN 'soap' THEN 'soap' WHEN 'seguro obligatorio' THEN 'soap' WHEN 'seguro obligatorio de accidentes personales' THEN 'soap'
 WHEN 'revisión técnica' THEN 'inspection' WHEN 'revision tecnica' THEN 'inspection' WHEN 'revision_tecnica' THEN 'inspection' ELSE NULL END;
$$ LANGUAGE sql IMMUTABLE;
-- Preserve original documents/dates. Recognize only known types; unknown labels
-- are not silently promoted into mandatory road documents.
WITH ranked AS (
 SELECT id,vehicle_road_requirement_code(document_type) code,
 row_number() OVER(PARTITION BY truck_id,vehicle_road_requirement_code(document_type) ORDER BY (road_requirement_code IS NOT NULL) DESC,created_at DESC NULLS LAST,id DESC) rn
 FROM vehicle_documents WHERE vehicle_road_requirement_code(document_type) IS NOT NULL
)
UPDATE vehicle_documents d SET road_requirement_code=CASE WHEN r.rn=1 THEN r.code ELSE NULL END,road_requirement_superseded=(r.rn>1)
 FROM ranked r WHERE d.id=r.id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_road_requirement ON vehicle_documents(truck_id,road_requirement_code) WHERE road_requirement_code IS NOT NULL;
CREATE OR REPLACE FUNCTION classify_vehicle_road_requirement() RETURNS trigger AS $$
BEGIN
 IF NOT NEW.road_requirement_superseded THEN NEW.road_requirement_code=vehicle_road_requirement_code(NEW.document_type); END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_vehicle_road_requirement ON vehicle_documents;
CREATE TRIGGER trg_vehicle_road_requirement BEFORE INSERT OR UPDATE OF document_type ON vehicle_documents
 FOR EACH ROW EXECUTE FUNCTION classify_vehicle_road_requirement();

-- Technical driver identities created for login/license registration are not
-- automatically fleet onboardings. Existing fleet records keep their history.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='drivers' AND column_name='operational_registered_at') THEN
  ALTER TABLE drivers ADD COLUMN operational_registered_at TIMESTAMPTZ;
  UPDATE drivers SET operational_registered_at=now();
 END IF;
END $$;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS operational_registered_by BIGINT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS profile_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS driver_profile_events(
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,driver_id INTEGER NOT NULL,
 actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,actor_name TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('fine','suspension','note')),
 event_date DATE NOT NULL,ends_on DATE,amount_clp NUMERIC CHECK(amount_clp IS NULL OR amount_clp>=0),
 notes TEXT NOT NULL CHECK(length(btrim(notes)) BETWEEN 1 AND 2000),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,driver_id) REFERENCES drivers(company_id,id) ON DELETE RESTRICT,
 CHECK(ends_on IS NULL OR ends_on>=event_date),CHECK(event_type<>'suspension' OR ends_on IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_driver_profile_events ON driver_profile_events(company_id,driver_id,id DESC);
CREATE OR REPLACE FUNCTION driver_profile_event_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'El historial del conductor es inmutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_driver_profile_event_immutable ON driver_profile_events;
CREATE TRIGGER trg_driver_profile_event_immutable BEFORE UPDATE OR DELETE ON driver_profile_events
 FOR EACH ROW EXECUTE FUNCTION driver_profile_event_immutable();
COMMIT;
