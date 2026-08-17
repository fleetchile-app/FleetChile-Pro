-- Link trips with routes and operational resources
ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_id BIGINT REFERENCES routes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id);
