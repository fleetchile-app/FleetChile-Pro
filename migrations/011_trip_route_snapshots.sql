-- FleetChile Pro - Fase 3.4 / snapshot de ruta planificada del viaje
-- Additive only. Existing trips remain valid without a planned route.

CREATE TABLE IF NOT EXISTS trip_route_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  road_route_id BIGINT REFERENCES road_routes(id) ON DELETE SET NULL,
  origin_location_id BIGINT REFERENCES operational_locations(id) ON DELETE SET NULL,
  destination_location_id BIGINT REFERENCES operational_locations(id) ON DELETE SET NULL,
  distance_meters NUMERIC NOT NULL,
  duration_seconds NUMERIC NOT NULL,
  geometry JSONB NOT NULL,
  provider TEXT NOT NULL,
  route_calculated_at TIMESTAMPTZ NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trip_route_snapshots_distance_nonnegative CHECK (distance_meters >= 0),
  CONSTRAINT trip_route_snapshots_duration_nonnegative CHECK (duration_seconds >= 0)
);

ALTER TABLE trips ADD COLUMN IF NOT EXISTS planned_route_snapshot_id BIGINT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trips_planned_route_snapshot_fk') THEN
    ALTER TABLE trips ADD CONSTRAINT trips_planned_route_snapshot_fk
      FOREIGN KEY (planned_route_snapshot_id) REFERENCES trip_route_snapshots(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trip_route_snapshots_trip_created
  ON trip_route_snapshots(trip_id, created_at DESC, id DESC);

COMMENT ON TABLE trip_route_snapshots IS 'Snapshot inmutable del calculo vial utilizado para planificar un viaje.';
