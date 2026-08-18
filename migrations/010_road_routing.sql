-- FleetChile Pro - Fase 3.3 / ruteo por carretera
-- Additive only. It does not alter trips or legacy routes.

CREATE TABLE IF NOT EXISTS road_routes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  origin_location_id BIGINT NOT NULL REFERENCES operational_locations(id) ON DELETE RESTRICT,
  destination_location_id BIGINT NOT NULL REFERENCES operational_locations(id) ON DELETE RESTRICT,
  distance_meters NUMERIC NOT NULL,
  duration_seconds NUMERIC NOT NULL,
  geometry JSONB NOT NULL,
  provider TEXT NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT road_routes_distance_nonnegative CHECK (distance_meters >= 0),
  CONSTRAINT road_routes_duration_nonnegative CHECK (duration_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS idx_road_routes_company_locations
  ON road_routes(company_id, origin_location_id, destination_location_id, calculated_at DESC);

COMMENT ON TABLE road_routes IS 'Snapshots de rutas viales calculadas entre ubicaciones operacionales. No reemplaza routes ni se asocia automaticamente a trips.';
