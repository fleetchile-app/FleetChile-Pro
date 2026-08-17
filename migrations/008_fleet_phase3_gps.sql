-- FleetChile Pro - Fase 3 / GPS y posiciones
-- Additive only. No provider GPS is introduced here.

CREATE INDEX IF NOT EXISTS idx_telemetry_truck_recorded_id ON telemetry(truck_id, recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_trip_recorded ON telemetry(trip_id, recorded_at DESC) WHERE trip_id IS NOT NULL;

COMMENT ON TABLE telemetry IS 'Fase 3: historial canónico de posiciones GPS de vehículos. trip_id es opcional y debe pertenecer a la misma empresa del camión.';
