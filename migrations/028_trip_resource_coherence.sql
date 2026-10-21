BEGIN;

-- Conservar detalles estructurados de cambios, además de notas legibles y auditoría.
ALTER TABLE trip_events ADD COLUMN IF NOT EXISTS details JSONB;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_source_type_valid;
ALTER TABLE alerts ADD CONSTRAINT alerts_source_type_valid
  CHECK (source_type IS NULL OR source_type IN ('maintenance','vehicle_document','driver_document','truck','checklist','trip')) NOT VALID;

-- Crear avisos actuales a partir de faltantes comprobables, sin reconstruir asignaciones pasadas.
INSERT INTO alerts(company_id,level,title,text,resolved,created_at,source_type,source_id,condition_code)
SELECT company_id,'critical','Viaje con recursos pendientes',
       'Viaje '||trip_number||': requiere completar camión y conductor',false,now(),'trip',id,'trip_resources_missing'
FROM trips
WHERE company_id IS NOT NULL AND status NOT IN ('Completado','Cancelado')
  AND (truck_id IS NULL OR driver_id IS NULL)
ON CONFLICT (company_id,source_type,source_id,condition_code)
WHERE resolved=false AND source_type IS NOT NULL AND source_id IS NOT NULL AND condition_code IS NOT NULL
DO NOTHING;

UPDATE alerts a SET resolved=true,resolved_at=now(),resolution_note='Condición de recursos resuelta'
FROM trips t
WHERE a.company_id=t.company_id AND a.source_type='trip' AND a.source_id=t.id
  AND a.condition_code='trip_resources_missing' AND a.resolved=false
  AND (t.status IN ('Completado','Cancelado') OR (t.truck_id IS NOT NULL AND t.driver_id IS NOT NULL));

COMMIT;
