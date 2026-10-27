BEGIN;
ALTER TABLE trip_itinerary_events DROP CONSTRAINT IF EXISTS trip_itinerary_events_kind_check;
ALTER TABLE trip_itinerary_events ADD CONSTRAINT trip_itinerary_events_kind_check CHECK(kind IN ('arrive','depart','pickup','failed','partial','reschedule','delay'));
ALTER TABLE trip_itinerary_events ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS driver_mobile_actions (
 id BIGSERIAL PRIMARY KEY,
 company_id BIGINT NOT NULL,trip_id BIGINT NOT NULL,
 actor_user_id BIGINT NOT NULL REFERENCES users(id),driver_id BIGINT NOT NULL REFERENCES drivers(id),
 resource_version INTEGER NOT NULL,client_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('accept','checklist')),
 payload_hash TEXT NOT NULL,result JSONB NOT NULL,
 reported_at TIMESTAMPTZ,confirmed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(trip_id,actor_user_id,client_key),
 FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id)
);
CREATE INDEX IF NOT EXISTS idx_driver_mobile_assignment ON driver_mobile_actions(company_id,trip_id,resource_version,driver_id);
DROP TRIGGER IF EXISTS trg_driver_mobile_immutable ON driver_mobile_actions;
CREATE TRIGGER trg_driver_mobile_immutable BEFORE UPDATE OR DELETE ON driver_mobile_actions FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision();
COMMIT;
