-- Operational workflow: dispatch, checklist, load, delivery/POD and trip events
CREATE TABLE IF NOT EXISTS trip_status_history (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  notes TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trip_delivery_proofs (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  load_id BIGINT REFERENCES trip_loads(id) ON DELETE SET NULL,
  recipient_name TEXT,
  recipient_rut TEXT,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  signature_url TEXT,
  photo_url TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_events_trip_time ON trip_events(trip_id,event_time DESC);
CREATE INDEX IF NOT EXISTS idx_trip_status_history_trip ON trip_status_history(trip_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_proofs_trip ON trip_delivery_proofs(trip_id,delivered_at DESC);
