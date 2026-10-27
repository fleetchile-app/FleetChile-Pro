BEGIN;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS itinerary_version INTEGER NOT NULL DEFAULT 0 CHECK(itinerary_version>=0);
CREATE TABLE IF NOT EXISTS trip_itinerary_revisions (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,trip_id BIGINT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),resource_version INTEGER NOT NULL,
 plan JSONB NOT NULL,reason TEXT NOT NULL,actor_user_id BIGINT REFERENCES users(id),actor_name TEXT NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(trip_id,version),FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id)
);
CREATE TABLE IF NOT EXISTS trip_itinerary_events (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,trip_id BIGINT NOT NULL,
 itinerary_version INTEGER NOT NULL,event_key TEXT NOT NULL,stop_key TEXT,load_id BIGINT,
 kind TEXT NOT NULL CHECK(kind IN ('arrive','depart','failed','partial','reschedule','delay')),
 minutes INTEGER CHECK(minutes>=0 AND minutes<=10080),delivered_kg NUMERIC CHECK(delivered_kg>0),
 reason TEXT,actor_user_id BIGINT REFERENCES users(id),actor_name TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(trip_id,event_key),
 FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id),
 FOREIGN KEY(trip_id,itinerary_version) REFERENCES trip_itinerary_revisions(trip_id,version)
);
CREATE INDEX IF NOT EXISTS idx_itinerary_events_trip ON trip_itinerary_events(company_id,trip_id,id);
DROP TRIGGER IF EXISTS trg_itinerary_revision_immutable ON trip_itinerary_revisions;
CREATE TRIGGER trg_itinerary_revision_immutable BEFORE UPDATE OR DELETE ON trip_itinerary_revisions FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision();
DROP TRIGGER IF EXISTS trg_itinerary_event_immutable ON trip_itinerary_events;
CREATE TRIGGER trg_itinerary_event_immutable BEFORE UPDATE OR DELETE ON trip_itinerary_events FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision();
CREATE OR REPLACE FUNCTION guard_itinerary_plan() RETURNS trigger AS $$
BEGIN
 IF NEW.itinerary_version<>OLD.itinerary_version OR (OLD.itinerary_version>0 AND
  ROW(NEW.planned_departure,NEW.planned_arrival,NEW.distance_km) IS DISTINCT FROM ROW(OLD.planned_departure,OLD.planned_arrival,OLD.distance_km)) THEN
  IF NEW.itinerary_version<>OLD.itinerary_version+1 OR NOT EXISTS(
   SELECT 1 FROM trip_itinerary_revisions r WHERE r.trip_id=NEW.id AND r.company_id=NEW.company_id AND r.version=NEW.itinerary_version
  ) THEN RAISE EXCEPTION 'El plan versionado debe modificarse desde su itinerario auditado'; END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_itinerary_plan ON trips;
CREATE TRIGGER trg_guard_itinerary_plan BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION guard_itinerary_plan();
COMMIT;
