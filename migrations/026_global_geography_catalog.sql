BEGIN;

-- Global official geography catalog foundation. Data is intentionally loaded later.
CREATE TABLE IF NOT EXISTS geo_regions (
  id BIGSERIAL PRIMARY KEY,
  official_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS geo_provinces (
  id BIGSERIAL PRIMARY KEY,
  official_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  region_id BIGINT NOT NULL REFERENCES geo_regions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geo_provinces_region ON geo_provinces(region_id);

CREATE TABLE IF NOT EXISTS geo_communes (
  id BIGSERIAL PRIMARY KEY,
  official_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  province_id BIGINT NOT NULL REFERENCES geo_provinces(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geo_communes_province ON geo_communes(province_id);

CREATE TABLE IF NOT EXISTS geo_localities (
  id BIGSERIAL PRIMARY KEY,
  official_code TEXT UNIQUE,
  name TEXT NOT NULL,
  commune_id BIGINT NOT NULL REFERENCES geo_communes(id) ON DELETE RESTRICT,
  type TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  source TEXT,
  source_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geo_localities_commune ON geo_localities(commune_id);
CREATE INDEX IF NOT EXISTS idx_geo_localities_name ON geo_localities(name);

COMMIT;
