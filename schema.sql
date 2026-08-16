CREATE TABLE IF NOT EXISTS trucks(
 id SERIAL PRIMARY KEY, patente TEXT UNIQUE NOT NULL, tipo TEXT NOT NULL, capacidad_t NUMERIC NOT NULL,
 driver TEXT, status TEXT NOT NULL DEFAULT 'Disponible', km INTEGER DEFAULT 0, lat NUMERIC, lng NUMERIC,
 location TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drivers(
 id SERIAL PRIMARY KEY, name TEXT NOT NULL, rut TEXT, license TEXT, expiry DATE, status TEXT DEFAULT 'Activo'
);
CREATE TABLE IF NOT EXISTS routes(
 id SERIAL PRIMARY KEY, truck_id INTEGER REFERENCES trucks(id) ON DELETE SET NULL, truck TEXT, origin TEXT, destination TEXT,
 distance_km NUMERIC DEFAULT 0, progress INTEGER DEFAULT 0, status TEXT DEFAULT 'Planificada', eta TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS loads(
 id SERIAL PRIMARY KEY, client TEXT, guide TEXT, cargo TEXT, weight_kg NUMERIC DEFAULT 0, volume_m3 NUMERIC DEFAULT 0,
 value_clp BIGINT DEFAULT 0, truck TEXT, origin TEXT, destination TEXT, status TEXT DEFAULT 'Planificada', delivered_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS maintenance(
 id SERIAL PRIMARY KEY, truck TEXT, item TEXT, due DATE, cost_clp BIGINT DEFAULT 0, status TEXT DEFAULT 'Pendiente'
);
CREATE TABLE IF NOT EXISTS fuel(
 id SERIAL PRIMARY KEY, date DATE DEFAULT CURRENT_DATE, truck TEXT, liters NUMERIC DEFAULT 0, price_clp NUMERIC DEFAULT 0,
 total_clp NUMERIC DEFAULT 0, station TEXT
);
CREATE TABLE IF NOT EXISTS alerts(
 id SERIAL PRIMARY KEY, level TEXT, title TEXT, text TEXT, resolved BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telemetry(
 id BIGSERIAL PRIMARY KEY, truck_id INTEGER REFERENCES trucks(id) ON DELETE CASCADE,
 lat NUMERIC NOT NULL, lng NUMERIC NOT NULL, speed_kmh NUMERIC DEFAULT 0, km INTEGER DEFAULT 0,
 recorded_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_truck_time ON telemetry(truck_id, recorded_at DESC);
