-- FleetChile Pro - Fase 3.2 / geografia operacional
-- Additive only. Existing textual locations remain unchanged.

CREATE TABLE IF NOT EXISTS operational_locations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  commune TEXT,
  region TEXT,
  lat NUMERIC NOT NULL,
  lng NUMERIC NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT,
  normalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operational_locations_lat_range CHECK (lat >= -90 AND lat <= 90),
  CONSTRAINT operational_locations_lng_range CHECK (lng >= -180 AND lng <= 180)
);

CREATE INDEX IF NOT EXISTS idx_operational_locations_company_name
  ON operational_locations(company_id, name);

COMMENT ON TABLE operational_locations IS 'Ubicaciones normalizadas y reutilizables de una empresa. No reemplaza client_locations ni migra datos legacy.';
