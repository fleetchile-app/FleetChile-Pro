BEGIN;
CREATE TABLE IF NOT EXISTS fleet_compositions (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,
 truck_id INTEGER NOT NULL,trailer_id INTEGER,valid_from TIMESTAMPTZ NOT NULL,valid_until TIMESTAMPTZ,
 active BOOLEAN NOT NULL DEFAULT true,version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(trailer_id IS NULL OR trailer_id<>truck_id),CHECK(valid_until IS NULL OR valid_until>valid_from),
 FOREIGN KEY(company_id,truck_id) REFERENCES trucks(company_id,id),
 FOREIGN KEY(company_id,trailer_id) REFERENCES trucks(company_id,id),UNIQUE(company_id,id)
);
CREATE INDEX IF NOT EXISTS idx_compositions_company ON fleet_compositions(company_id,active,id);
CREATE TABLE IF NOT EXISTS fleet_composition_revisions (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,composition_id BIGINT NOT NULL,version INTEGER NOT NULL,
 actor_user_id BIGINT REFERENCES users(id),actor_name TEXT NOT NULL,recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 reason TEXT NOT NULL,snapshot JSONB NOT NULL,
 FOREIGN KEY(company_id,composition_id) REFERENCES fleet_compositions(company_id,id),UNIQUE(composition_id,version)
);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS trailer_id INTEGER;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS composition_id BIGINT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS composition_snapshot JSONB;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS resource_version INTEGER NOT NULL DEFAULT 0 CHECK(resource_version>=0);
CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_trip_company ON trips(company_id,id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='trip_trailer_company') THEN
  ALTER TABLE trips ADD CONSTRAINT trip_trailer_company FOREIGN KEY(company_id,trailer_id) REFERENCES trucks(company_id,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='trip_composition_company') THEN
  ALTER TABLE trips ADD CONSTRAINT trip_composition_company FOREIGN KEY(company_id,composition_id) REFERENCES fleet_compositions(company_id,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='trip_different_equipment') THEN
  ALTER TABLE trips ADD CONSTRAINT trip_different_equipment CHECK(trailer_id IS NULL OR truck_id IS NOT NULL AND trailer_id<>truck_id);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_trips_trailer_active ON trips(company_id,trailer_id,status) WHERE trailer_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS trip_resource_revisions (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,trip_id BIGINT NOT NULL,version INTEGER NOT NULL CHECK(version>=0),
 effective_at TIMESTAMPTZ,recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),baseline_observation BOOLEAN NOT NULL DEFAULT false,
 actor_user_id BIGINT REFERENCES users(id),actor_name TEXT NOT NULL,reason TEXT NOT NULL,snapshot JSONB NOT NULL,
 CHECK((baseline_observation AND effective_at IS NULL AND version=0) OR (NOT baseline_observation AND effective_at IS NOT NULL AND version>0)),
 FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id),UNIQUE(trip_id,version)
);
CREATE OR REPLACE FUNCTION immutable_resource_revision() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Las revisiones de recursos son inmutables'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_composition_revision_immutable ON fleet_composition_revisions;
CREATE TRIGGER trg_composition_revision_immutable BEFORE UPDATE OR DELETE ON fleet_composition_revisions FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision();
DROP TRIGGER IF EXISTS trg_trip_resource_revision_immutable ON trip_resource_revisions;
CREATE TRIGGER trg_trip_resource_revision_immutable BEFORE UPDATE OR DELETE ON trip_resource_revisions FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision();
CREATE OR REPLACE FUNCTION guard_versioned_trip_resources() RETURNS trigger AS $$
BEGIN
 IF OLD.resource_version>0 AND (
  NEW.resource_version<OLD.resource_version OR NEW.resource_version>OLD.resource_version+1 OR
  (ROW(NEW.truck_id,NEW.trailer_id,NEW.driver_id,NEW.client_id,NEW.route_id,NEW.composition_id,NEW.composition_snapshot)
   IS DISTINCT FROM ROW(OLD.truck_id,OLD.trailer_id,OLD.driver_id,OLD.client_id,OLD.route_id,OLD.composition_id,OLD.composition_snapshot)
   AND NEW.resource_version<>OLD.resource_version+1)
 ) THEN RAISE EXCEPTION 'Los recursos versionados deben modificarse desde su asignación auditada'; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_versioned_trip_resources ON trips;
CREATE TRIGGER trg_guard_versioned_trip_resources BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION guard_versioned_trip_resources();
-- Do not fabricate coupling or assignment history for existing trips/vehicles.
COMMIT;
