-- FleetChile Pro - pre-Fase 3 architectural integrity
-- Additive and non-destructive. Existing data is preserved.

ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS trip_id BIGINT REFERENCES trips(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_telemetry_trip_time ON telemetry(trip_id, recorded_at DESC);

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so these checks are guarded.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='telemetry_lat_range') THEN
    ALTER TABLE telemetry ADD CONSTRAINT telemetry_lat_range CHECK (lat >= -90 AND lat <= 90) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='telemetry_lng_range') THEN
    ALTER TABLE telemetry ADD CONSTRAINT telemetry_lng_range CHECK (lng >= -180 AND lng <= 180) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='telemetry_speed_nonnegative') THEN
    ALTER TABLE telemetry ADD CONSTRAINT telemetry_speed_nonnegative CHECK (speed_kmh >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='telemetry_km_nonnegative') THEN
    ALTER TABLE telemetry ADD CONSTRAINT telemetry_km_nonnegative CHECK (km >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trucks_company_required') THEN
    ALTER TABLE trucks ADD CONSTRAINT trucks_company_required CHECK (company_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='drivers_company_required') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_company_required CHECK (company_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routes_company_required') THEN
    ALTER TABLE routes ADD CONSTRAINT routes_company_required CHECK (company_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loads_company_required') THEN
    ALTER TABLE loads ADD CONSTRAINT loads_company_required CHECK (company_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='maintenance_company_required') THEN
    ALTER TABLE maintenance ADD CONSTRAINT maintenance_company_required CHECK (company_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fuel_company_required') THEN
    ALTER TABLE fuel ADD CONSTRAINT fuel_company_required CHECK (company_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='alerts_company_required') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_company_required CHECK (company_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='clients_company_required') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_company_required CHECK (company_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trips_company_required') THEN
    ALTER TABLE trips ADD CONSTRAINT trips_company_required CHECK (company_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trucks_company_status ON trucks(company_id, status);
CREATE INDEX IF NOT EXISTS idx_routes_company_status ON routes(company_id, status);
CREATE INDEX IF NOT EXISTS idx_loads_company_status ON loads(company_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_company_due ON maintenance(company_id, due);
CREATE INDEX IF NOT EXISTS idx_fuel_company_date ON fuel(company_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_company_open ON alerts(company_id, resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_company_updated ON trips(company_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_trip_events_trip_created ON trip_events(trip_id, created_by, event_time DESC);

COMMENT ON TABLE routes IS 'Canonical route resource. Legacy text route fields in loads are retained for compatibility.';
COMMENT ON TABLE loads IS 'LEGACY compatibility model. New operational loads belong in trip_loads and are linked to trips.';
COMMENT ON TABLE trip_loads IS 'Canonical operational load model for trips.';
COMMENT ON TABLE trips IS 'Canonical operational trip aggregate.';
COMMENT ON TABLE trip_status_history IS 'Canonical history of trip status transitions.';
COMMENT ON TABLE trip_events IS 'Canonical event timeline; not a replacement for status history.';
COMMENT ON TABLE telemetry IS 'Canonical vehicle position history; trip_id is nullable until a position is associated with a trip.';
